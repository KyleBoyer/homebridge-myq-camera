import { createDecipheriv, randomBytes } from 'node:crypto';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import type { Camera, ConnectionInfo } from './types';

const MAGIC = Buffer.from('SDNK');
const VERSION = Buffer.from([1, 0, 0]);
const TYPE_REGISTER = 1;
const TYPE_PEERS = 2;
const TYPE_PUNCH = 3;
const TYPE_CONNECT = 4;
const TYPE_CONNECTED = 5;
const TYPE_RELAY_ACK = 100;
const TALKBACK_OPEN = 0x07;
const TALKBACK_DATA = 0x09;
const MULAW_SILENCE = 0xff;

interface Channel {
  socket: Socket;
  control: boolean;
  peer?: { address: string; port: number };
  connected: boolean;
}

function sdnk(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(20);
  MAGIC.copy(header);
  VERSION.copy(header, 4);
  header[7] = type;
  header.writeUInt32BE(payload.length, 16);
  return Buffer.concat([header, payload]);
}

function mediaId(kind: string, deviceId: string): Buffer {
  const value = Buffer.from(`${kind}_${deviceId}`, 'ascii').subarray(0, 32);
  return Buffer.concat([value, Buffer.alloc(32 - value.length)]);
}

export function registerPacket(
  kind: string,
  deviceId: string,
  localIp: string,
  localPort: number,
  control: boolean,
): Buffer {
  const id = mediaId(kind, deviceId);
  const address = Buffer.from(localIp.split('.').map(Number));
  const port = Buffer.alloc(2);
  port.writeUInt16BE(localPort);
  return sdnk(TYPE_REGISTER, Buffer.concat([
    Buffer.from([1, 0, 0, Number(control)]),
    Buffer.from(kind),
    address,
    Buffer.alloc(16),
    port,
    id,
    id,
  ]));
}

function relayAckPacket(kind: string, deviceId: string, control: boolean): Buffer {
  const id = mediaId(kind, deviceId);
  return sdnk(TYPE_RELAY_ACK, Buffer.concat([
    Buffer.from([1, Number(control)]),
    Buffer.from(kind),
    id,
    id,
  ]));
}

function punchPacket(kind: string, deviceId: string, sequence: number): Buffer {
  const id = mediaId(kind, deviceId);
  return sdnk(TYPE_PUNCH, Buffer.concat([Buffer.from([1, sequence & 0xff]), id, id]));
}

function connectPacket(attempt = 1): Buffer {
  return sdnk(TYPE_CONNECT, Buffer.from([attempt & 0xff]));
}

export function parsePeerPacket(data: Buffer): Array<{ address: string; port: number }> {
  if (data.length !== 110 || !data.subarray(0, 4).equals(MAGIC) || data[7] !== TYPE_PEERS) {
    return [];
  }
  const endpoints: Array<{ address: string; port: number }> = [];
  for (let offset = 20; offset < 108; offset += 22) {
    const addressBytes = [...data.subarray(offset, offset + 4)];
    const port = data.readUInt16BE(offset + 20);
    if (addressBytes.some(Boolean) && port) {
      endpoints.push({ address: addressBytes.join('.'), port });
    }
  }
  return endpoints;
}

function isPrivate(address: string): boolean {
  const octets = address.split('.').map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function bind(socket: Socket, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      socket.off('error', onError);
      resolve();
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(port);
  });
}

async function bindPair(): Promise<[Socket, Socket]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const media = createSocket('udp4');
    await bind(media, 0);
    const port = media.address().port;
    if (port === 65535) {
      media.close();
      continue;
    }
    const control = createSocket('udp4');
    try {
      await bind(control, port + 1);
      return [media, control];
    } catch {
      media.close();
      control.close();
    }
  }
  throw new Error('could not allocate consecutive RTP/RTCP ports');
}

function localAddress(remote: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', reject);
    socket.connect(9, remote, () => {
      const address = socket.address().address;
      socket.close();
      resolve(address);
    });
  });
}

function send(channel: Channel, data: Buffer, peer: { address: string; port: number }): void {
  channel.socket.send(data, peer.port, peer.address);
}

function decrypt(key: string, blob: Buffer): Buffer {
  if (key.length !== 16 || blob.length < 32) throw new Error('invalid AES media blob');
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key, 'ascii'), blob.subarray(0, 16));
  return Buffer.concat([decipher.update(blob.subarray(16)), decipher.final()]);
}

export function buildTalkbackPacket(
  frameIndex: number,
  ssrc: number,
  destination: Buffer,
  startMs: Buffer,
  g711: Buffer,
  type = TALKBACK_DATA,
  field2 = frameIndex,
  timestampBase = 0,
): Buffer {
  const fragment = Buffer.alloc(8);
  fragment.writeUInt32LE(frameIndex >>> 0);
  fragment.writeUInt16LE(1, 4);
  const rtp = Buffer.alloc(12);
  rtp[0] = 0x80;
  rtp[1] = 0x08;
  rtp.writeUInt16BE(frameIndex & 0xffff, 2);
  rtp.writeUInt32BE((timestampBase + frameIndex * 160) >>> 0, 4);
  rtp.writeUInt32BE(ssrc >>> 0, 8);
  const trailer = type === TALKBACK_DATA ? Buffer.alloc(4) : Buffer.alloc(0);
  const field1 = 1 + startMs.length + 4 + 4 + g711.length + trailer.length;
  const envelope = Buffer.alloc(4 + 5 + 2 + destination.length + 4 + 1 + startMs.length + 4 + 4);
  let offset = 0;
  MAGIC.copy(envelope, offset); offset += 4;
  Buffer.from([1, type, 1, 0, 0]).copy(envelope, offset); offset += 5;
  envelope.writeUInt16LE(destination.length, offset); offset += 2;
  destination.copy(envelope, offset); offset += destination.length;
  envelope.writeUInt32LE(field1, offset); offset += 4;
  envelope[offset] = startMs.length; offset += 1;
  startMs.copy(envelope, offset); offset += startMs.length;
  envelope.writeUInt32LE(field2 >>> 0, offset); offset += 4;
  envelope.writeUInt32LE(g711.length, offset);
  return Buffer.concat([fragment, rtp, envelope, g711, trailer]);
}

export class P2PMediaSession extends EventEmitter {
  private channels: Channel[] = [];
  private localIp = '';
  private frameNumber?: number;
  private fragments: Buffer[] = [];
  private reportTimer?: NodeJS.Timeout;
  private sourceSsrc?: number;
  private baseSequence?: number;
  private maxSequence?: number;
  private cycles = 0;
  private received = 0;
  private expectedPrior = 0;
  private receivedPrior = 0;
  private lastTransit?: number;
  private jitter = 0;
  private lastSenderReport = 0;
  private lastSenderReportAt = 0;
  readonly localSsrc = randomBytes(4).readUInt32BE();

  private talkBuffer = Buffer.alloc(0);
  private talkQueue: Buffer[] = [];
  private talkStarted = false;
  private talkReady = false;
  private talkTimer?: NodeJS.Timeout;
  private talkFrameIndex = 0;
  private talkSequence = 0;
  private talkStartMs = Buffer.alloc(0);
  private talkTimestampBase = 0;

  constructor(
    readonly camera: Camera,
    readonly info: ConnectionInfo,
    readonly kind: 'V' | 'A',
    readonly magic: 'w1' | 'wa',
    readonly clockRate: number,
  ) {
    super();
    if (!info.relayHost || !info.relayPort) throw new Error('missing relay endpoint');
  }

  async punch(timeoutMs = 5_000): Promise<void> {
    const [media, control] = await bindPair();
    this.localIp = await localAddress(this.info.relayHost);
    this.channels = [
      { socket: media, control: false, connected: false },
      { socket: control, control: true, connected: false },
    ];
    this.channels.forEach((channel) => {
      channel.socket.on('message', (data, remote) => this.onMessage(channel, data, remote));
      channel.socket.on('error', (error) => this.emit('error', error));
    });

    let sequence = 0;
    const drive = setInterval(() => {
      for (const channel of this.channels) {
        if (!channel.peer) {
          send(channel, registerPacket(
            this.kind,
            this.camera.deviceId,
            this.localIp,
            channel.socket.address().port,
            channel.control,
          ), { address: this.info.relayHost, port: this.info.relayPort });
        } else if (!channel.connected) {
          send(channel, punchPacket(this.kind, this.camera.deviceId, sequence), channel.peer);
          send(channel, connectPacket(), channel.peer);
        }
      }
      sequence = Math.min(sequence + 1, 2);
    }, 100);

    let timeout: NodeJS.Timeout | undefined;
    let check: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Seedonk hole punch timed out')), timeoutMs);
        check = setInterval(() => {
          if (this.channels.every((channel) => channel.connected)) {
            resolve();
          }
        }, 25);
      });
    } finally {
      clearInterval(drive);
      if (timeout) clearTimeout(timeout);
      if (check) clearInterval(check);
    }
    this.reportTimer = setInterval(() => this.sendReceiverReport(), 2_000);
  }

  private onMessage(channel: Channel, data: Buffer, remote: RemoteInfo): void {
    if (data.subarray(0, 4).equals(MAGIC) && data.length >= 20) {
      const type = data[7];
      if (type === TYPE_PEERS) {
        const endpoints = parsePeerPacket(data);
        channel.peer = endpoints.find((endpoint) => endpoint.address === this.camera.localIp)
          ?? endpoints.find((endpoint) => isPrivate(endpoint.address) && endpoint.address !== this.localIp)
          ?? endpoints.at(-1);
        if (channel.peer) {
          send(channel, relayAckPacket(this.kind, this.camera.deviceId, channel.control), {
            address: this.info.relayHost,
            port: this.info.relayPort,
          });
        }
      } else if (type === TYPE_PUNCH) {
        channel.peer = { address: remote.address, port: remote.port };
        for (let sequence = 0; sequence < 3; sequence += 1) {
          send(channel, punchPacket(this.kind, this.camera.deviceId, sequence), channel.peer);
        }
      } else if (type === TYPE_CONNECT) {
        channel.peer = { address: remote.address, port: remote.port };
        send(channel, sdnk(TYPE_CONNECTED, data.subarray(20, 21).length
          ? data.subarray(20, 21) : Buffer.from([1])), channel.peer);
      } else if (type === TYPE_CONNECTED) {
        channel.peer = { address: remote.address, port: remote.port };
        channel.connected = true;
      }
      return;
    }
    if (channel.control) this.handleRtcp(data);
    else this.handleMedia(data);
  }

  private handleMedia(data: Buffer): void {
    if (data.length < 8) return;
    const frameNumber = data.readUInt32LE();
    if (this.frameNumber === undefined) this.frameNumber = frameNumber;
    else if (frameNumber !== this.frameNumber) {
      this.flushRtp();
      this.frameNumber = frameNumber;
    }
    this.fragments.push(data.subarray(8));
  }

  private flushRtp(): void {
    if (!this.fragments.length) return;
    const rtp = Buffer.concat(this.fragments);
    this.fragments = [];
    if (rtp.length < 12 || rtp[0] >> 6 !== 2) return;
    this.observeRtp(rtp);
    this.processPayload(rtp.subarray(12));
  }

  private processPayload(payload: Buffer): void {
    if (payload.length < 10 || payload.subarray(0, 2).toString() !== this.magic) return;
    const length = payload.readUInt32LE(2);
    if (length + 6 !== payload.length) return;
    const encrypted = ((payload[6] & 0xe0) >> 5) === 1;
    const combinedLength = length - 4;
    let combined = payload.subarray(10, 10 + combinedLength);
    try {
      if (encrypted) combined = decrypt(this.info.aesKey, combined);
    } catch {
      return;
    }
    for (let offset = 0; offset + 4 <= combined.length;) {
      const recordLength = combined.readUInt32LE(offset);
      offset += 4;
      const end = offset + recordLength;
      if (recordLength <= 0 || end > combined.length) break;
      this.emit('record', Buffer.from(combined.subarray(offset, end)));
      offset = end;
    }
  }

  private observeRtp(rtp: Buffer): void {
    const sequence = rtp.readUInt16BE(2);
    const timestamp = rtp.readUInt32BE(4);
    const ssrc = rtp.readUInt32BE(8);
    if (this.sourceSsrc !== ssrc) {
      this.sourceSsrc = ssrc;
      this.baseSequence = sequence;
      this.maxSequence = sequence;
      this.cycles = 0;
      this.received = 0;
      this.expectedPrior = 0;
      this.receivedPrior = 0;
      this.lastTransit = undefined;
      this.jitter = 0;
    } else if (this.maxSequence !== undefined) {
      if (sequence < this.maxSequence && this.maxSequence - sequence > 0x8000) {
        this.cycles += 0x10000;
      }
      if (sequence > this.maxSequence || this.maxSequence - sequence > 0x8000) {
        this.maxSequence = sequence;
      }
    }
    this.received += 1;
    const transit = performance.now() * this.clockRate / 1000 - timestamp;
    if (this.lastTransit !== undefined) {
      const delta = Math.abs(transit - this.lastTransit);
      this.jitter += (delta - this.jitter) / 16;
    }
    this.lastTransit = transit;
  }

  private handleRtcp(data: Buffer): void {
    for (let offset = 0; offset + 4 <= data.length;) {
      const first = data[offset];
      const type = data[offset + 1];
      const size = (data.readUInt16BE(offset + 2) + 1) * 4;
      if (first >> 6 !== 2 || size < 4 || offset + size > data.length) return;
      if (type === 200 && size >= 20) {
        const msw = data.readUInt32BE(offset + 8);
        const lsw = data.readUInt32BE(offset + 12);
        this.lastSenderReport = (((msw & 0xffff) << 16) | (lsw >>> 16)) >>> 0;
        this.lastSenderReportAt = performance.now();
      }
      offset += size;
    }
  }

  private receiverReport(): Buffer | undefined {
    if (
      this.sourceSsrc === undefined
      || this.baseSequence === undefined
      || this.maxSequence === undefined
    ) return undefined;
    const extendedMax = this.cycles + this.maxSequence;
    const expected = extendedMax - this.baseSequence + 1;
    let lost = expected - this.received;
    const expectedInterval = expected - this.expectedPrior;
    const receivedInterval = this.received - this.receivedPrior;
    const lostInterval = expectedInterval - receivedInterval;
    const fraction = expectedInterval <= 0 || lostInterval <= 0
      ? 0 : Math.min(255, Math.floor(lostInterval * 256 / expectedInterval));
    this.expectedPrior = expected;
    this.receivedPrior = this.received;
    lost = Math.max(-(1 << 23), Math.min((1 << 23) - 1, lost));
    const report = Buffer.alloc(32);
    report[0] = 0x81;
    report[1] = 201;
    report.writeUInt16BE(7, 2);
    report.writeUInt32BE(this.localSsrc, 4);
    report.writeUInt32BE(this.sourceSsrc, 8);
    report[12] = fraction;
    report.writeUIntBE(lost & 0xffffff, 13, 3);
    report.writeUInt32BE(extendedMax >>> 0, 16);
    report.writeUInt32BE(Math.floor(this.jitter) >>> 0, 20);
    report.writeUInt32BE(this.lastSenderReport, 24);
    const delay = this.lastSenderReportAt
      ? Math.floor((performance.now() - this.lastSenderReportAt) * 65.536) : 0;
    report.writeUInt32BE(delay >>> 0, 28);
    return report;
  }

  private sendReceiverReport(): void {
    const channel = this.channels[1];
    const report = this.receiverReport();
    if (channel?.peer && report) send(channel, report, channel.peer);
  }

  enqueueTalkback(data: Buffer): void {
    if (this.kind !== 'A') throw new Error('talkback requires an audio session');
    this.talkBuffer = Buffer.concat([this.talkBuffer, data]);
    while (this.talkBuffer.length >= 160) {
      this.talkQueue.push(Buffer.from(this.talkBuffer.subarray(0, 160)));
      this.talkBuffer = this.talkBuffer.subarray(160);
    }
    if (!this.talkStarted && this.talkQueue.length) this.startTalkback();
    else if (this.talkReady && this.talkQueue.length) this.pumpTalkback();
  }

  private startTalkback(): void {
    this.talkStarted = true;
    this.talkStartMs = Buffer.from(String(Date.now()));
    this.talkTimestampBase = randomBytes(4).readUInt32BE() & 0x7fffffff;
    let delay = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      setTimeout(() => this.sendTalkbackFrame(Buffer.alloc(0), TALKBACK_OPEN, 1), delay);
      delay += 20;
      setTimeout(() => this.sendTalkbackFrame(Buffer.alloc(0), TALKBACK_DATA, 0), delay);
      delay += 20;
    }
    setTimeout(() => {
      this.talkReady = true;
      this.pumpTalkback();
    }, delay);
  }

  private sendTalkbackFrame(data: Buffer, type: number, field2: number): void {
    const channel = this.channels[0];
    if (!channel?.peer) return;
    const value = buildTalkbackPacket(
      this.talkFrameIndex,
      this.localSsrc,
      Buffer.from(this.camera.cxsDestination),
      this.talkStartMs,
      data,
      type,
      field2,
      this.talkTimestampBase,
    );
    this.talkFrameIndex += 1;
    send(channel, value, channel.peer);
  }

  private pumpTalkback(): void {
    if (!this.talkReady || this.talkTimer) return;
    const pump = (): void => {
      this.talkTimer = undefined;
      const frame = this.talkQueue.shift();
      if (!frame) return;
      this.sendTalkbackFrame(frame, TALKBACK_DATA, this.talkSequence);
      this.talkSequence += 1;
      this.talkTimer = setTimeout(pump, 20);
    };
    pump();
  }

  close(): void {
    if (this.reportTimer) clearInterval(this.reportTimer);
    if (this.talkTimer) clearTimeout(this.talkTimer);
    this.sendBye();
    this.channels.forEach((channel) => channel.socket.close());
    this.channels = [];
  }

  /**
   * RTCP BYE (PT 203) on the control channel: tell the camera this receiver is
   * leaving so it can free its single-viewer slot promptly instead of waiting
   * out the receiver-report timeout. Best-effort — sent right before the
   * sockets close, mirroring the app's native RTP teardown.
   */
  private sendBye(): void {
    const channel = this.channels[1];
    if (!channel?.peer) return;
    const bye = Buffer.alloc(8);
    bye[0] = 0x81; // version 2, source count 1
    bye[1] = 203; // BYE
    bye.writeUInt16BE(1, 2); // length in 32-bit words minus one
    bye.writeUInt32BE(this.localSsrc, 4);
    try {
      send(channel, bye, channel.peer);
      send(channel, bye, channel.peer);
    } catch {
      // best-effort; the socket is about to close regardless
    }
  }
}
