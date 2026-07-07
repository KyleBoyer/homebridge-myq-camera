import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Writable } from 'node:stream';
import type {
  API,
  CameraController,
  CameraStreamingOptions,
  CameraStreamingDelegate,
  HAP,
  PrepareStreamCallback,
  PrepareStreamRequest,
  SnapshotRequest,
  SnapshotRequestCallback,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge';
import { MyqCameraSession, TendConnectionManager } from './session';
import type { CameraConfig, MyqPlatformConfig, PluginLogger } from './types';

interface SessionInfo {
  address: string;
  ipv6: boolean;
  videoPort: number;
  videoReturnPort: number;
  videoSrtp: Buffer;
  videoSsrc: number;
  audioPort?: number;
  audioReturnPort?: number;
  audioSrtp?: Buffer;
  audioSsrc?: number;
}

interface ActiveSession {
  camera: MyqCameraSession;
  ffmpeg?: ChildProcess;
  returnFfmpeg?: ChildProcess;
  returnSocket?: Socket;
  timeout?: NodeJS.Timeout;
  cleanup: (reason?: string) => void;
}

type ErrorEmitter = {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
};

function reservePort(ipv6: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(ipv6 ? 'udp6' : 'udp4');
    socket.once('error', reject);
    socket.bind(0, ipv6 ? '::' : '0.0.0.0', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

function isExpectedTeardownError(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ECONNRESET'
    || error.code === 'EPIPE'
    || error.code === 'ERR_STREAM_DESTROYED'
    || error.code === 'ERR_STREAM_PREMATURE_CLOSE'
    || error.code === 'ERR_STREAM_WRITE_AFTER_END';
}

function pipeLabel(error: NodeJS.ErrnoException): string {
  return error.code ? `${error.code}: ${error.message}` : error.message;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause ? `${error.message}; caused by ${describeError(cause)}` : error.message;
  }
  return String(error);
}

function observeErrors(
  emitter: ErrorEmitter | null | undefined,
  onError: (error: NodeJS.ErrnoException) => void,
): void {
  emitter?.on('error', onError);
}

function write(
  stream: Writable | null,
  data: Buffer,
  onError?: (error: NodeJS.ErrnoException) => void,
): void {
  if (!stream || stream.destroyed || !stream.writable) return;
  try {
    stream.write(data);
  } catch (error) {
    onError?.(error as NodeJS.ErrnoException);
  }
}

// MPEG-4 AudioSpecificConfig values for AAC-ELD, mono, 480-sample short frames.
// HomeKit commonly chooses 24 kHz/20 ms for return audio even when 16 kHz is
// also advertised. If this config's sampling-frequency index does not match the
// RTP rate, FFmpeg still decodes, but speech is pitch-shifted/slowed.
const AAC_ELD_CONFIGS = new Map<number, string>([
  [8000, 'F8F63000'],
  [16000, 'F8F03000'],
  [22050, 'F8EE3000'],
  [24000, 'F8EC3000'],
  [32000, 'F8EA3000'],
]);

function aacEldConfig(sampleRate: number): string {
  const config = AAC_ELD_CONFIGS.get(sampleRate);
  if (!config) throw new Error(`unsupported HomeKit AAC-ELD sample rate: ${sampleRate}`);
  return config;
}

export class StreamingDelegate implements CameraStreamingDelegate {
  readonly controller: CameraController;
  private readonly pending = new Map<string, SessionInfo>();
  private readonly active = new Map<string, ActiveSession>();
  private sessionLock: Promise<void> = Promise.resolve();
  private lastSnapshot?: Buffer;
  private lastSnapshotAt = 0;
  private lastSnapshotPollAt = 0;
  private viewingStartedAt = 0;
  private readonly snapshotFile: string;
  private readonly snapshotTtlMs: number;
  private snapshotRefreshing = false;

  private readonly wantAudio: boolean;
  private readonly wantTalkback: boolean;
  private readonly copyVideo: boolean;

  constructor(
    private readonly hap: HAP,
    private readonly log: PluginLogger,
    private readonly config: MyqPlatformConfig,
    private readonly cameraConfig: CameraConfig,
    private readonly connection: TendConnectionManager,
    private readonly ffmpegPath: string,
    api: API,
  ) {
    this.wantAudio = config.audio !== false;
    this.wantTalkback = this.wantAudio && config.talkback !== false;
    this.copyVideo = config.copyVideo === true;

    // Persist snapshots to the Homebridge storage dir so a restart (or update)
    // serves the last still without opening a fresh camera session — a TC
    // camera serves one viewer at a time, and HomeKit fetches a snapshot right
    // before it starts a stream, so a cold snapshot session would race the
    // stream's hole punch.
    const slug = (cameraConfig.deviceId || cameraConfig.name || 'camera')
      .replace(/[^\w.-]+/g, '_');
    this.snapshotFile = join(api.user.storagePath(), 'myq-camera', `snapshot-${slug}.jpg`);
    // How stale a cached still may be before it is refreshed in the background.
    // Default 120s; 0 disables background refresh (serve cache until the next
    // stream). A persisted snapshot loads as already stale so the first poll
    // after a restart triggers a refresh.
    const interval = config.snapshotRefreshInterval;
    this.snapshotTtlMs = interval === 0 ? 0 : Math.max(15, interval ?? 120) * 1000;
    try {
      this.lastSnapshot = readFileSync(this.snapshotFile);
      // Load as fresh: a restart must NOT open a snapshot session, or it would
      // race the stream a user starts moments later on this single-viewer
      // camera. Staleness is handled later, only after sustained tile viewing.
      this.lastSnapshotAt = Date.now();
    } catch {
      // no persisted snapshot yet — the first request takes a live one
    }

    const resolutions: Array<[number, number, number]> = this.copyVideo
      ? [[1280, 720, 20]]
      : [[1280, 720, 20], [1280, 720, 15], [640, 360, 20], [320, 240, 15]];
    const streamingOptions: CameraStreamingOptions = {
      supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
      video: {
        resolutions,
        codec: {
          profiles: [hap.H264Profile.BASELINE],
          levels: [hap.H264Level.LEVEL3_1],
        },
      },
    };
    if (this.wantAudio) {
      streamingOptions.audio = {
        twoWayAudio: this.wantTalkback,
        codecs: [{
          type: this.wantTalkback
            ? hap.AudioStreamingCodecType.AAC_ELD
            : hap.AudioStreamingCodecType.OPUS,
          samplerate: [
            hap.AudioStreamingSamplerate.KHZ_16,
            hap.AudioStreamingSamplerate.KHZ_24,
          ],
        }],
      };
    }
    this.controller = new hap.CameraController({
      cameraStreamCount: 1,
      delegate: this,
      streamingOptions,
    });
    api.on('shutdown', () => this.shutdown());
  }

  private cameraSession(audio = this.wantAudio): MyqCameraSession {
    return new MyqCameraSession(this.connection, this.log, {
      camera: this.cameraConfig.deviceId,
      audio,
    });
  }

  private withSession(operation: () => Promise<void>): void {
    const run = this.sessionLock.then(operation);
    this.sessionLock = run.catch((error) => this.log.error(String(error)));
  }

  private async persistSnapshot(image: Buffer): Promise<void> {
    this.lastSnapshot = image;
    this.lastSnapshotAt = Date.now();
    try {
      await mkdir(dirname(this.snapshotFile), { recursive: true });
      await writeFile(this.snapshotFile, image);
    } catch (error) {
      this.log.debug(`[${this.cameraConfig.name}] could not persist snapshot: ${describeError(error)}`);
    }
  }

  /**
   * Refresh the cached still from an active stream so snapshots stay current
   * without ever opening a competing session. Taps the video frames already
   * flowing from the camera into a one-shot FFmpeg that emits a single JPEG.
   */
  private refreshSnapshotFromStream(camera: MyqCameraSession): void {
    if (this.snapshotRefreshing) return;
    // Skip if the cached still is already fresh enough.
    if (this.lastSnapshot && Date.now() - this.lastSnapshotAt < (this.snapshotTtlMs || 120_000)) return;
    this.snapshotRefreshing = true;
    const ffmpeg = spawn(this.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'h264', '-i', 'pipe:0',
      '-frames:v', '1', '-f', 'image2', 'pipe:1',
    ]);
    const chunks: Buffer[] = [];
    const onVideo = (frame: Buffer): void => write(ffmpeg.stdin, frame, () => {});
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      camera.removeListener('video', onVideo);
      this.snapshotRefreshing = false;
      ffmpeg.kill('SIGKILL');
      if (chunks.length) void this.persistSnapshot(Buffer.concat(chunks));
    };
    const guard = setTimeout(finish, 8_000);
    ffmpeg.stdout.on('data', (data: Buffer) => chunks.push(data));
    observeErrors(ffmpeg.stdin, () => {});
    observeErrors(ffmpeg.stdout, () => {});
    observeErrors(ffmpeg.stderr, () => {});
    ffmpeg.once('error', finish);
    ffmpeg.once('close', finish);
    camera.on('video', onVideo);
  }

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    // Serve the cached still instantly whenever we have one. Opening a dedicated
    // snapshot session would take the camera's single viewer slot moments before
    // HomeKit starts a stream, and the camera needs time to release it — the
    // classic snapshot→stream hole-punch collision.
    if (this.lastSnapshot) {
      callback(undefined, this.lastSnapshot);
      this.maybeRefreshStaleSnapshot(request.width, request.height);
      return;
    }
    if (this.active.size > 0) {
      callback(new Error('camera is streaming; snapshot will be available shortly'));
      return;
    }
    // Cold cache (first ever use): capture a live still and answer with it.
    this.captureSnapshot(request.width, request.height, callback);
  }

  /**
   * Refresh a stale cached still in the background, but only once the tile has
   * been viewed continuously for a while. HomeKit polls a visible tile roughly
   * every 10s; a user who opens the app and taps to stream produces just one or
   * two polls before the stream, so debouncing here guarantees we never spawn a
   * competing snapshot session in that window — which on a single-viewer camera
   * would race the stream's hole punch. Refresh only kicks in for sustained
   * tile-watching, when a stream is not imminent.
   */
  private maybeRefreshStaleSnapshot(width: number, height: number): void {
    if (this.snapshotTtlMs <= 0 || this.active.size > 0 || this.snapshotRefreshing) return;
    const now = Date.now();
    if (now - this.lastSnapshotPollAt > 15_000) this.viewingStartedAt = now;
    this.lastSnapshotPollAt = now;
    if (now - this.lastSnapshotAt <= this.snapshotTtlMs) return;
    if (now - this.viewingStartedAt < 25_000) return;
    this.captureSnapshot(width, height);
  }

  /**
   * Capture one live still into the cache (and disk), optionally answering a
   * HomeKit snapshot request. Opens a short video-only session, so callers must
   * only invoke it when not already streaming; concurrent captures are skipped.
   */
  private captureSnapshot(width: number, height: number, callback?: SnapshotRequestCallback): void {
    if (this.snapshotRefreshing) {
      callback?.(new Error('a snapshot capture is already in progress'), this.lastSnapshot);
      return;
    }
    this.snapshotRefreshing = true;
    this.withSession(async () => {
      const camera = this.cameraSession(false);
      const ffmpeg = spawn(this.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'h264', '-i', 'pipe:0',
        '-frames:v', '1',
        '-vf',
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
          + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        '-f', 'image2', 'pipe:1',
      ]);
      const chunks: Buffer[] = [];
      let completed = false;
      const finish = (error?: Error): void => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        camera.close();
        ffmpeg.kill('SIGKILL');
        this.snapshotRefreshing = false;
        const image = chunks.length ? Buffer.concat(chunks) : undefined;
        if (image) void this.persistSnapshot(image);
        callback?.(error ?? (image ? undefined : new Error('snapshot produced no image')), image);
      };
      const timeout = setTimeout(() => finish(new Error('snapshot timeout')), 15_000);
      ffmpeg.stdout.on('data', (data: Buffer) => chunks.push(data));
      ffmpeg.stderr.on('data', (data: Buffer) => this.debugFfmpeg('snapshot', data));
      observeErrors(ffmpeg.stdin, (error) => {
        if (!completed && !isExpectedTeardownError(error)) finish(error);
      });
      observeErrors(ffmpeg.stdout, (error) => {
        if (!completed && !isExpectedTeardownError(error)) finish(error);
      });
      observeErrors(ffmpeg.stderr, (error) => {
        if (!completed && !isExpectedTeardownError(error)) finish(error);
      });
      ffmpeg.once('error', finish);
      ffmpeg.once('close', () => finish());
      camera.on('video', (frame: Buffer) => write(ffmpeg.stdin, frame, (error) => {
        if (!completed && !isExpectedTeardownError(error)) finish(error);
      }));
      camera.once('error', (error: Error) => finish(error));
      try {
        await camera.open();
      } catch (error) {
        finish(error as Error);
      }
    });
  }

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    try {
      const ipv6 = request.addressVersion === 'ipv6';
      const requestAudio = (request as { audio?: PrepareStreamRequest['audio'] }).audio;
      const videoReturnPort = await reservePort(ipv6);
      const audioReturnPort = this.wantAudio && requestAudio ? await reservePort(ipv6) : undefined;
      const info: SessionInfo = {
        address: request.targetAddress,
        ipv6,
        videoPort: request.video.port,
        videoReturnPort,
        videoSrtp: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
        videoSsrc: this.hap.CameraController.generateSynchronisationSource(),
      };
      if (this.wantAudio && requestAudio && audioReturnPort) {
        info.audioPort = requestAudio.port;
        info.audioReturnPort = audioReturnPort;
        info.audioSrtp = Buffer.concat([requestAudio.srtp_key, requestAudio.srtp_salt]);
        info.audioSsrc = this.hap.CameraController.generateSynchronisationSource();
      }
      this.pending.set(request.sessionID, info);
      callback(undefined, {
        video: {
          port: info.videoReturnPort,
          ssrc: info.videoSsrc,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
        ...(info.audioReturnPort !== undefined && info.audioSsrc !== undefined && requestAudio
          ? {
            audio: {
              port: info.audioReturnPort,
              ssrc: info.audioSsrc,
              srtp_key: requestAudio.srtp_key,
              srtp_salt: requestAudio.srtp_salt,
            },
          }
          : {}),
      });
    } catch (error) {
      this.log.warn(`HomeKit stream preparation failed for ${this.cameraConfig.name}: ${describeError(error)}`);
      callback(error as Error);
    }
  }

  private outputArguments(request: StartStreamRequest, info: SessionInfo, hasAudio: boolean): string[] {
    const video = request.video;
    const bitrate = video.max_bit_rate || 800;
    const fps = video.fps || 20;
    const mtu = video.mtu || 1316;
    const args = [
      '-hide_banner', '-loglevel', this.config.debug ? 'verbose' : 'warning',
      '-fflags', '+genpts+discardcorrupt',
      '-f', 'h264', '-r', '20', '-i', 'pipe:3',
    ];
    if (hasAudio) args.push('-f', 'mulaw', '-ar', '8000', '-ac', '1', '-i', 'pipe:4');

    args.push('-map', '0:v:0', '-an', '-sn', '-dn');
    if (this.copyVideo) {
      args.push('-codec:v', 'copy');
    } else {
      args.push(
        '-codec:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
        '-profile:v', 'baseline', '-level:v', '3.1', '-pix_fmt', 'yuv420p',
        '-r', String(fps),
        '-vf', `scale=${video.width}:${video.height}:force_original_aspect_ratio=decrease`,
        '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`,
        '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
      );
    }
    args.push(
      '-payload_type', String(video.pt),
      '-ssrc', String(info.videoSsrc),
      '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', info.videoSrtp.toString('base64'),
      `srtp://${info.address}:${info.videoPort}?rtcpport=${info.videoPort}&pkt_size=${mtu}`,
    );

    if (hasAudio) {
      if (info.audioPort === undefined || !info.audioSrtp) {
        throw new Error('HomeKit audio endpoint was not prepared');
      }
      const audio = request.audio;
      args.push('-map', '1:a:0', '-vn', '-sn', '-dn');
      if (audio.codec === this.hap.AudioStreamingCodecType.AAC_ELD) {
        args.push('-codec:a', 'libfdk_aac', '-profile:a', 'aac_eld');
      } else {
        args.push('-codec:a', 'libopus', '-application', 'lowdelay');
      }
      args.push(
        '-flags', '+global_header',
        '-ar', `${audio.sample_rate}k`, '-ac', String(audio.channel),
        '-b:a', `${audio.max_bit_rate || 24}k`,
        '-payload_type', String(audio.pt),
        '-ssrc', String(info.audioSsrc),
        '-f', 'rtp',
        '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
        '-srtp_out_params', info.audioSrtp.toString('base64'),
        `srtp://${info.address}:${info.audioPort}?rtcpport=${info.audioPort}&pkt_size=188`,
      );
    }
    return args;
  }

  private returnAudioSdp(request: StartStreamRequest, info: SessionInfo): string {
    if (info.audioReturnPort === undefined || !info.audioSrtp) {
      throw new Error('HomeKit talkback endpoint was not prepared');
    }
    const ipVersion = info.ipv6 ? 'IP6' : 'IP4';
    const payloadType = request.audio.pt;
    const sampleRate = request.audio.sample_rate * 1000;
    const config = aacEldConfig(sampleRate);
    return [
      'v=0',
      `o=- 0 0 IN ${ipVersion} ${info.address}`,
      's=Talk',
      `c=IN ${ipVersion} ${info.address}`,
      't=0 0',
      `m=audio ${info.audioReturnPort} RTP/AVP ${payloadType}`,
      'b=AS:24',
      `a=rtpmap:${payloadType} MPEG4-GENERIC/${sampleRate}/1`,
      'a=rtcp-mux',
      `a=fmtp:${payloadType} profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;`
        + `indexdeltalength=3;config=${config}`,
      `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${info.audioSrtp.toString('base64')}`,
      '',
    ].join('\r\n');
  }

  private startReturnAudio(
    request: StartStreamRequest,
    camera: MyqCameraSession,
    info: SessionInfo,
  ): ChildProcess {
    let loggedDecodedAudio = false;
    const child = spawn(this.ffmpegPath, [
      '-hide_banner', '-loglevel', this.config.debug ? 'verbose' : 'warning',
      '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
      '-c:a', 'libfdk_aac',
      '-f', 'sdp', '-i', 'pipe:0',
      '-map', '0:a:0', '-ac', '1', '-ar', '8000',
      '-af', 'highpass=f=120,lowpass=f=3400,alimiter=limit=0.95',
      '-f', 'mulaw', 'pipe:1',
    ]);
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (isExpectedTeardownError(error)) {
        this.log.debug?.(`[${this.cameraConfig.name}] HomeKit talkback receiver closed: ${pipeLabel(error)}`);
      } else {
        this.log.warn(`HomeKit talkback receiver failed: ${pipeLabel(error)}`);
      }
    });
    observeErrors(child.stdin, (error) => {
      if (!isExpectedTeardownError(error)) {
        this.log.warn(`HomeKit talkback SDP pipe failed: ${pipeLabel(error)}`);
      }
    });
    observeErrors(child.stdout, (error) => {
      if (!isExpectedTeardownError(error)) {
        this.log.warn(`HomeKit talkback audio pipe failed: ${pipeLabel(error)}`);
      }
    });
    observeErrors(child.stderr, (error) => {
      if (!isExpectedTeardownError(error)) {
        this.log.warn(`HomeKit talkback log pipe failed: ${pipeLabel(error)}`);
      }
    });
    child.stdout.on('data', (data: Buffer) => {
      if (!loggedDecodedAudio) {
        loggedDecodedAudio = true;
        this.log.info(`Received HomeKit push-to-talk audio for ${this.cameraConfig.name}`);
      }
      camera.writeTalkback(data);
    });
    child.stderr.on('data', (data: Buffer) => this.debugFfmpeg('talkback', data));
    child.once('close', (code, signal) => {
      if (this.config.debug) {
        this.log.debug(
          `[${this.cameraConfig.name}] HomeKit talkback receiver exited `
          + `(code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        );
      }
    });
    try {
      child.stdin.end(this.returnAudioSdp(request, info));
    } catch (error) {
      const pipeError = error as NodeJS.ErrnoException;
      if (!isExpectedTeardownError(pipeError)) {
        this.log.warn(`HomeKit talkback SDP write failed: ${pipeLabel(pipeError)}`);
      }
    }
    return child;
  }

  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
    const info = this.pending.get(request.sessionID);
    if (!info) {
      callback(new Error('unknown HomeKit stream session'));
      return;
    }
    this.withSession(async () => {
      const camera = this.cameraSession(this.wantAudio);
      let started = false;
      let cleaned = false;
      let callbackCompleted = false;
      let startupTimeout: NodeJS.Timeout | undefined;
      let resolveLock!: () => void;
      const holdLock = new Promise<void>((resolve) => { resolveLock = resolve; });
      const finishCallback = (error?: Error): void => {
        if (callbackCompleted) return;
        callbackCompleted = true;
        callback(error);
      };
      const active: ActiveSession = {
        camera,
        cleanup: (reason = 'unknown') => {
          if (cleaned) return;
          const wasStarted = started;
          cleaned = true;
          if (startupTimeout) clearTimeout(startupTimeout);
          if (active.timeout) clearTimeout(active.timeout);
          try { active.returnSocket?.close(); } catch {}
          active.ffmpeg?.kill('SIGKILL');
          active.returnFfmpeg?.kill('SIGKILL');
          camera.close();
          this.active.delete(request.sessionID);
          this.pending.delete(request.sessionID);
          if (wasStarted) {
            this.log.info(`Stopped HomeKit stream for ${this.cameraConfig.name} (${reason})`);
          }
          resolveLock();
        },
      };
      this.active.set(request.sessionID, active);
      try {
        startupTimeout = setTimeout(() => {
          if (started || cleaned) return;
          const error = new Error('HomeKit stream startup timed out');
          this.log.warn(`HomeKit stream failed for ${this.cameraConfig.name}: ${error.message}`);
          finishCallback(error);
          active.cleanup('startup-timeout');
        }, 45_000);
        this.log.info(
          `Starting HomeKit stream for ${this.cameraConfig.name} `
          + `(${request.video.width}x${request.video.height}@${request.video.fps}fps)`,
        );
        await camera.open();
        if (cleaned) return;
        const hasHomeKitAudio = Boolean((request as { audio?: StartStreamRequest['audio'] }).audio);
        const hasAudio = camera.hasAudio && hasHomeKitAudio
          && info.audioPort !== undefined && info.audioReturnPort !== undefined
          && info.audioSsrc !== undefined && !!info.audioSrtp;
        const ffmpeg = spawn(
          this.ffmpegPath,
          this.outputArguments(request, info, hasAudio),
          { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
        );
        active.ffmpeg = ffmpeg;
        const videoInput = ffmpeg.stdio[3] as Writable;
        const audioInput = ffmpeg.stdio[4] as Writable;
        const handlePipeError = (scope: string, error: NodeJS.ErrnoException): void => {
          if (isExpectedTeardownError(error)) {
            if (this.config.debug) {
              this.log.debug(`[${this.cameraConfig.name}] ${scope} closed during stream teardown: ${pipeLabel(error)}`);
            }
            return;
          }
          this.log.warn(`[${this.cameraConfig.name}] ${scope} pipe failed: ${pipeLabel(error)}`);
          active.cleanup('ffmpeg-pipe-error');
        };
        observeErrors(videoInput, (error) => handlePipeError('ffmpeg video input', error));
        observeErrors(audioInput, (error) => handlePipeError('ffmpeg audio input', error));
        observeErrors(ffmpeg.stderr, (error) => handlePipeError('ffmpeg log output', error));
        camera.on('video', (frame: Buffer) => write(
          videoInput,
          frame,
          (error) => handlePipeError('ffmpeg video input', error),
        ));
        if (hasAudio) {
          camera.on('audio', (frame: Buffer) => write(
            audioInput,
            frame,
            (error) => handlePipeError('ffmpeg audio input', error),
          ));
        } else if (this.wantAudio && camera.hasAudio) {
          this.log.warn(`HomeKit did not prepare audio for ${this.cameraConfig.name}; streaming video-only`);
        }
        camera.on('error', (error: Error) => {
          this.log.error(`myQ media error: ${error.message}`);
          active.cleanup('camera-error');
        });
        ffmpeg.stderr?.on('data', (data: Buffer) => this.debugFfmpeg('stream', data));
        ffmpeg.once('error', (error: NodeJS.ErrnoException) => {
          if (!started) {
            this.log.warn(`[${this.cameraConfig.name}] ffmpeg stream process failed before startup: ${pipeLabel(error)}`);
            finishCallback(error);
          }
          else if (!isExpectedTeardownError(error)) {
            this.log.warn(`[${this.cameraConfig.name}] ffmpeg stream process failed: ${pipeLabel(error)}`);
          }
          active.cleanup('ffmpeg-error');
        });
        ffmpeg.once('close', (code, signal) => {
          if (!started && !callbackCompleted) {
            const error = new Error(
              `ffmpeg stream exited before startup (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
            );
            this.log.warn(`HomeKit stream failed for ${this.cameraConfig.name}: ${error.message}`);
            finishCallback(error);
          }
          active.cleanup('ffmpeg-exit');
        });

        const returnSocket = createSocket(info.ipv6 ? 'udp6' : 'udp4');
        active.returnSocket = returnSocket;
        returnSocket.on('error', (error) => {
          this.log.error(`HomeKit RTCP socket failed: ${error.message}`);
          active.cleanup('rtcp-error');
        });
        returnSocket.on('message', () => {
          if (active.timeout) clearTimeout(active.timeout);
          active.timeout = setTimeout(() => {
            this.log.info(`HomeKit client inactive; stopping ${this.cameraConfig.name}`);
            this.controller.forceStopStreamingSession(request.sessionID);
            active.cleanup('homekit-inactive');
          }, Math.max(5, request.video.rtcp_interval * 5) * 1000);
        });
        returnSocket.bind(info.videoReturnPort);

        if (this.wantTalkback && hasAudio) {
          this.log.info(
            `HomeKit push-to-talk ready for ${this.cameraConfig.name} `
            + `(${request.audio.codec}/${request.audio.sample_rate}kHz, `
            + `ptime=${request.audio.packet_time}ms, pt=${request.audio.pt})`,
          );
          active.returnFfmpeg = this.startReturnAudio(request, camera, info);
        }
        started = true;
        if (startupTimeout) clearTimeout(startupTimeout);
        finishCallback();
        this.log.info(`Started HomeKit stream for ${this.cameraConfig.name}`);
        this.refreshSnapshotFromStream(camera);
      } catch (error) {
        this.log.warn(`HomeKit stream failed for ${this.cameraConfig.name}: ${describeError(error)}`);
        if (this.config.debug && error instanceof Error && error.stack) {
          this.log.debug(`[${this.cameraConfig.name}] stream startup stack: ${error.stack}`);
        }
        if (!started) finishCallback(error as Error);
        active.cleanup(started ? 'stream-error' : 'startup-failure');
      }
      await holdLock;
    });
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case this.hap.StreamRequestTypes.START:
        this.startStream(request, callback);
        break;
      case this.hap.StreamRequestTypes.RECONFIGURE:
        callback();
        break;
      case this.hap.StreamRequestTypes.STOP:
        this.active.get(request.sessionID)?.cleanup('homekit-stop');
        callback();
        break;
      default:
        callback();
    }
  }

  private debugFfmpeg(scope: string, data: Buffer): void {
    const message = data.toString().trim();
    if (message) this.log.debug(`[${this.cameraConfig.name}] [ffmpeg:${scope}] ${message}`);
  }

  shutdown(): void {
    this.active.forEach((session) => session.cleanup('shutdown'));
    this.active.clear();
    this.pending.clear();
  }
}

export { reservePort };
