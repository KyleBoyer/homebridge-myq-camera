import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
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
  audioPort: number;
  audioReturnPort: number;
  audioSrtp: Buffer;
  audioSsrc: number;
}

interface ActiveSession {
  camera: MyqCameraSession;
  ffmpeg?: ChildProcess;
  returnFfmpeg?: ChildProcess;
  returnSocket?: Socket;
  timeout?: NodeJS.Timeout;
  cleanup: () => void;
}

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

function write(stream: Writable | null, data: Buffer): void {
  if (stream && !stream.destroyed) stream.write(data);
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

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    if (this.active.size > 0) {
      callback(
        this.lastSnapshot ? undefined : new Error('camera is busy streaming'),
        this.lastSnapshot,
      );
      return;
    }
    this.withSession(async () => {
      const camera = this.cameraSession(false);
      const ffmpeg = spawn(this.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'h264', '-i', 'pipe:0',
        '-frames:v', '1',
        '-vf',
        `scale=${request.width}:${request.height}:force_original_aspect_ratio=decrease,`
          + `pad=${request.width}:${request.height}:(ow-iw)/2:(oh-ih)/2`,
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
        const image = chunks.length ? Buffer.concat(chunks) : undefined;
        if (image) this.lastSnapshot = image;
        callback(error ?? (image ? undefined : new Error('snapshot produced no image')), image);
      };
      const timeout = setTimeout(() => finish(new Error('snapshot timeout')), 15_000);
      ffmpeg.stdout.on('data', (data: Buffer) => chunks.push(data));
      ffmpeg.stderr.on('data', (data: Buffer) => this.debugFfmpeg('snapshot', data));
      ffmpeg.once('error', finish);
      ffmpeg.once('close', () => finish());
      camera.on('video', (frame: Buffer) => write(ffmpeg.stdin, frame));
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
      const [videoReturnPort, audioReturnPort] = await Promise.all([
        reservePort(ipv6),
        reservePort(ipv6),
      ]);
      const info: SessionInfo = {
        address: request.targetAddress,
        ipv6,
        videoPort: request.video.port,
        videoReturnPort,
        videoSrtp: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
        videoSsrc: this.hap.CameraController.generateSynchronisationSource(),
        audioPort: request.audio.port,
        audioReturnPort,
        audioSrtp: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
        audioSsrc: this.hap.CameraController.generateSynchronisationSource(),
      };
      this.pending.set(request.sessionID, info);
      callback(undefined, {
        video: {
          port: info.videoReturnPort,
          ssrc: info.videoSsrc,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
        audio: {
          port: info.audioReturnPort,
          ssrc: info.audioSsrc,
          srtp_key: request.audio.srtp_key,
          srtp_salt: request.audio.srtp_salt,
        },
      });
    } catch (error) {
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
    child.stdin.end(this.returnAudioSdp(request, info));
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
      let resolveLock!: () => void;
      const holdLock = new Promise<void>((resolve) => { resolveLock = resolve; });
      const active: ActiveSession = {
        camera,
        cleanup: () => {
          if (cleaned) return;
          cleaned = true;
          if (active.timeout) clearTimeout(active.timeout);
          try { active.returnSocket?.close(); } catch {}
          active.ffmpeg?.kill('SIGKILL');
          active.returnFfmpeg?.kill('SIGKILL');
          camera.close();
          this.active.delete(request.sessionID);
          this.pending.delete(request.sessionID);
          resolveLock();
        },
      };
      this.active.set(request.sessionID, active);
      try {
        await camera.open();
        const ffmpeg = spawn(
          this.ffmpegPath,
          this.outputArguments(request, info, camera.hasAudio),
          { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
        );
        active.ffmpeg = ffmpeg;
        const videoInput = ffmpeg.stdio[3] as Writable;
        const audioInput = ffmpeg.stdio[4] as Writable;
        camera.on('video', (frame: Buffer) => write(videoInput, frame));
        camera.on('audio', (frame: Buffer) => write(audioInput, frame));
        camera.on('error', (error: Error) => {
          this.log.error(`myQ media error: ${error.message}`);
          active.cleanup();
        });
        ffmpeg.stderr?.on('data', (data: Buffer) => this.debugFfmpeg('stream', data));
        ffmpeg.once('error', (error) => {
          if (!started) callback(error);
          active.cleanup();
        });
        ffmpeg.once('close', () => active.cleanup());

        const returnSocket = createSocket(info.ipv6 ? 'udp6' : 'udp4');
        active.returnSocket = returnSocket;
        returnSocket.on('error', (error) => {
          this.log.error(`HomeKit RTCP socket failed: ${error.message}`);
          active.cleanup();
        });
        returnSocket.on('message', () => {
          if (active.timeout) clearTimeout(active.timeout);
          active.timeout = setTimeout(() => {
            this.log.info(`HomeKit client inactive; stopping ${this.cameraConfig.name}`);
            this.controller.forceStopStreamingSession(request.sessionID);
            active.cleanup();
          }, Math.max(5, request.video.rtcp_interval * 5) * 1000);
        });
        returnSocket.bind(info.videoReturnPort);

        if (this.wantTalkback && camera.hasAudio) {
          this.log.info(
            `HomeKit push-to-talk ready for ${this.cameraConfig.name} `
            + `(${request.audio.codec}/${request.audio.sample_rate}kHz, `
            + `ptime=${request.audio.packet_time}ms, pt=${request.audio.pt})`,
          );
          active.returnFfmpeg = this.startReturnAudio(request, camera, info);
          active.returnFfmpeg.once('error', (error) => {
            this.log.warn(`HomeKit talkback receiver failed: ${error.message}`);
          });
        }
        started = true;
        callback();
        this.log.info(`Started HomeKit stream for ${this.cameraConfig.name}`);
      } catch (error) {
        if (!started) callback(error as Error);
        active.cleanup();
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
        this.active.get(request.sessionID)?.cleanup();
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
    this.active.forEach((session) => session.cleanup());
    this.active.clear();
    this.pending.clear();
  }
}

export { reservePort };
