import { EventEmitter } from 'node:events';
import { TokenManager } from './auth';
import { TendClient } from './cxs';
import { KeyframeGate } from './h264';
import { P2PMediaSession } from './p2p';
import type { Camera, PluginLogger } from './types';

export interface CameraSessionOptions {
  camera?: string;
  audio?: boolean;
  quality?: number;
  fps?: number;
  size?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TendConnectionManager {
  private client?: TendClient;
  private pending?: Promise<TendClient>;
  private keepalive?: NodeJS.Timeout;

  constructor(
    private readonly tokens: TokenManager,
    private readonly log: PluginLogger,
  ) {}

  async connect(): Promise<TendClient> {
    if (this.client) return this.client;
    if (this.pending) return this.pending;
    this.pending = this.create();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  private async create(): Promise<TendClient> {
    const client = new TendClient(await this.tokens.accessToken());
    try {
      await client.login(5);
    } catch (error) {
      client.close();
      throw error;
    }
    this.client = client;
    this.keepalive = setInterval(() => {
      try {
        client.cxs.keepalive();
      } catch (error) {
        this.log.warn(`myQ signaling keepalive failed: ${String(error)}`);
        this.invalidate(client);
      }
    }, 20_000);
    return client;
  }

  invalidate(client = this.client): void {
    if (!client || client !== this.client) return;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = undefined;
    client.close();
    this.client = undefined;
  }

  close(): void {
    this.invalidate();
  }
}

export class MyqCameraSession extends EventEmitter {
  private client?: TendClient;
  private video?: P2PMediaSession;
  private audio?: P2PMediaSession;
  private closed = false;
  camera?: Camera;

  constructor(
    private readonly connection: TendConnectionManager,
    private readonly log: PluginLogger,
    private readonly options: CameraSessionOptions = {},
  ) {
    super();
  }

  private async retry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        last = error;
        if (attempt + 1 < attempts) await delay(2_000);
      }
    }
    throw last;
  }

  async open(): Promise<void> {
    this.client = await this.connection.connect();
    const cameras = this.client.listCameras();
    this.camera = this.options.camera
      ? cameras.find((candidate) => (
        candidate.deviceId === this.options.camera || candidate.alias === this.options.camera
      ))
      : cameras[0];
    if (!this.camera) {
      throw new Error(this.options.camera
        ? `camera not found: ${this.options.camera}`
        : 'no Tend TC-series cameras found on this account');
    }

    const videoInfo = await this.retry(() => this.client!.getVideoConnection(this.camera!));
    this.video = new P2PMediaSession(this.camera, videoInfo, 'V', 'w1', 90_000);
    const gate = new KeyframeGate();
    this.video.on('record', (record: Buffer) => {
      gate.feed(record).forEach((frame) => this.emit('video', frame));
    });
    this.video.on('error', (error) => this.emit('error', error));
    await this.video.punch();
    this.client.startVideo(this.camera, videoInfo);
    this.client.setVideoQuality(
      this.camera,
      this.options.quality ?? 3,
      this.options.fps ?? 20,
      this.options.size ?? 0,
    );

    if (this.options.audio !== false) {
      try {
        const audioInfo = await this.retry(() => this.client!.getAudioConnection(this.camera!));
        this.audio = new P2PMediaSession(this.camera, audioInfo, 'A', 'wa', 8_000);
        this.audio.on('record', (record: Buffer) => {
          if (record.length > 4) this.emit('audio', record.subarray(4));
        });
        this.audio.on('error', (error) => this.emit('error', error));
        await this.audio.punch();
        this.client.startAudio(this.camera, audioInfo);
      } catch (error) {
        this.log.warn(`myQ audio unavailable; continuing video-only: ${String(error)}`);
        this.audio?.close();
        this.audio = undefined;
      }
    }

    this.log.info(`Connected native myQ session to ${this.camera.alias}`);
  }

  get hasAudio(): boolean {
    return this.audio !== undefined;
  }

  writeTalkback(data: Buffer): void {
    if (!this.audio) return;
    this.audio.enqueueTalkback(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.video?.close();
    this.audio?.close();
    this.video = undefined;
    this.audio = undefined;
    this.client = undefined;
  }
}
