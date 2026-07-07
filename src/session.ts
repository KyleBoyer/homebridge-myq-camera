import { EventEmitter } from 'node:events';
import { TokenManager } from './auth';
import { TendClient } from './cxs';
import { KeyframeGate } from './h264';
import { P2PMediaSession } from './p2p';
import type { Camera, ConnectionInfo, PluginLogger } from './types';

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
  private lastReleaseAt = 0;

  constructor(
    private readonly tokens: TokenManager,
    private readonly log: PluginLogger,
  ) {}

  /** Record when a media session let go of the camera's single-viewer slot. */
  noteRelease(): void {
    this.lastReleaseAt = Date.now();
  }

  /**
   * A TC camera serves one live viewer and needs a moment to free that slot
   * after a session closes. HomeKit fetches a snapshot immediately before it
   * starts a stream, so without a gap the stream's hole punch races the
   * just-closed snapshot session. Wait out a minimum cooldown since the last
   * release before opening the next session.
   */
  async awaitReleaseCooldown(minGapMs = 3_000): Promise<void> {
    if (!this.lastReleaseAt) return;
    const remaining = minGapMs - (Date.now() - this.lastReleaseAt);
    if (remaining > 0) await delay(remaining);
  }

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
  private videoInfo?: ConnectionInfo;
  private audio?: P2PMediaSession;
  private audioInfo?: ConnectionInfo;
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

  /**
   * Establish the video channel, retrying the hole punch through the brief
   * window where the camera is still releasing a prior viewer session. Each
   * attempt requests fresh connection info because the relay assignment may
   * change between tries.
   */
  private async establishVideo(attempts = 2): Promise<void> {
    // Capture stable references: close() nulls this.client/this.camera, and the
    // retry loop below awaits, so HomeKit tearing the session down mid-setup
    // must not turn into an undefined dereference. We bail via the `closed`
    // checks instead.
    const client = this.client;
    const camera = this.camera;
    if (!client || !camera) throw new Error('camera session was torn down before video setup');
    const noop = (): void => {};
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.closed) throw new Error('camera session closed during video setup');
      const info = await this.retry(() => client.getVideoConnection(camera), 2);
      const session = new P2PMediaSession(camera, info, 'V', 'w1', 90_000);
      session.on('error', noop); // absorb transient socket errors during the punch
      try {
        await session.punch(8_000);
      } catch (error) {
        last = error;
        session.close();
        if (this.closed || attempt + 1 >= attempts) throw last;
        this.log.warn(
          `myQ video hole punch failed (attempt ${attempt + 1}/${attempts}); the camera `
          + 'may still be releasing a prior session — retrying after a cooldown',
        );
        await delay(4_000);
        continue;
      }
      if (this.closed) {
        session.close();
        throw new Error('camera session closed during video setup');
      }
      session.removeListener('error', noop);
      const gate = new KeyframeGate();
      session.on('record', (record: Buffer) => {
        gate.feed(record).forEach((frame) => this.emit('video', frame));
      });
      session.on('error', (error) => this.emit('error', error));
      this.video = session;
      this.videoInfo = info;
      client.startVideo(camera, info);
      client.setVideoQuality(
        camera,
        this.options.quality ?? 3,
        this.options.fps ?? 20,
        this.options.size ?? 0,
      );
      return;
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

    await this.connection.awaitReleaseCooldown();
    await this.establishVideo();

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
        this.audioInfo = audioInfo;
      } catch (error) {
        this.log.warn(`myQ audio unavailable; continuing video-only: ${String(error)}`);
        this.audio?.close();
        this.audio = undefined;
        this.audioInfo = undefined;
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

  private stopSignaling(kind: 'video' | 'audio', info?: ConnectionInfo): void {
    if (!this.client || !this.camera || !info) return;
    try {
      if (kind === 'video') this.client.stopVideo(this.camera, info);
      else this.client.stopAudio(this.camera, info);
    } catch (error) {
      this.log.warn(`myQ ${kind} stop command failed; closing local sockets anyway: ${String(error)}`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopSignaling('video', this.videoInfo);
    this.stopSignaling('audio', this.audioInfo);
    this.video?.close();
    this.audio?.close();
    this.video = undefined;
    this.videoInfo = undefined;
    this.audio = undefined;
    this.audioInfo = undefined;
    this.client = undefined;
    this.connection.noteRelease();
  }
}
