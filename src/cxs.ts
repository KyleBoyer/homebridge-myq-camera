import { randomUUID } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Camera, ConnectionInfo } from './types';

const LOGIN_HOST = 'server.tend-us.tendplatform.com';
const LOGIN_PORT = 5104;
const ACTION_COMMAND = 411;
const ACTION_LOGIN = 519;
const ACTION_KEEPALIVE = 526;
const CLIENT_TYPE_PLUTO = 121;
const FIXED_HEADER = 27;
const SESSION_OPTIONS_SIZE = 16;
const MAX_PACKET = 2 * 1024 * 1024;

export interface CxsPacket {
  action: number;
  body: Buffer;
  options: Buffer;
  source: Buffer;
  result: number;
  clientType: number;
  destination: Buffer;
  targetId: bigint;
  version: number;
}

function packet(overrides: Partial<CxsPacket> & Pick<CxsPacket, 'action'>): CxsPacket {
  return {
    body: Buffer.alloc(0),
    options: Buffer.alloc(SESSION_OPTIONS_SIZE),
    source: Buffer.alloc(0),
    result: 2,
    clientType: CLIENT_TYPE_PLUTO,
    destination: Buffer.from('**'),
    targetId: 0n,
    version: 3,
    ...overrides,
  };
}

export function encodePacket(value: CxsPacket): Buffer {
  if (value.options.length % 16 !== 0 || value.destination.length !== 2) {
    throw new Error('invalid CXS options or destination length');
  }
  const headerLength = FIXED_HEADER + value.options.length + value.source.length;
  if (headerLength > 0xffff || value.body.length > MAX_PACKET) {
    throw new Error('CXS packet too large');
  }
  const header = Buffer.alloc(FIXED_HEADER);
  header[0] = 0x41;
  header[1] = value.version;
  header.writeUInt16LE(headerLength, 2);
  header.writeUInt16LE(value.options.length, 4);
  header[6] = 0;
  header.writeUInt32LE(value.body.length, 7);
  header.writeUInt16LE(value.clientType, 11);
  header.writeUInt16LE(value.action, 13);
  header.writeUInt16LE(value.result, 15);
  value.destination.copy(header, 17);
  header.writeBigUInt64LE(value.targetId, 19);
  return Buffer.concat([header, value.options, value.source, value.body]);
}

function decodePacket(data: Buffer): CxsPacket {
  const headerLength = data.readUInt16LE(2);
  const optionsLength = data.readUInt16LE(4);
  const sourceLength = headerLength - FIXED_HEADER - optionsLength;
  return {
    version: data[1],
    action: data.readUInt16LE(13),
    result: data.readUInt16LE(15),
    destination: data.subarray(17, 19),
    targetId: data.readBigUInt64LE(19),
    clientType: data.readUInt16LE(11),
    options: data.subarray(FIXED_HEADER, FIXED_HEADER + optionsLength),
    source: data.subarray(
      FIXED_HEADER + optionsLength,
      FIXED_HEADER + optionsLength + sourceLength,
    ),
    body: data.subarray(headerLength),
  };
}

function escapeProperty(value: string, key = false): string {
  let output = '';
  [...value].forEach((character, index) => {
    if (character === '\\') output += '\\\\';
    else if (character === '\t') output += '\\t';
    else if (character === '\n') output += '\\n';
    else if (character === '\r') output += '\\r';
    else if (character === '\f') output += '\\f';
    else if ('=:'.includes(character) || (key && ' #!'.includes(character))) output += `\\${character}`;
    else if (character === ' ' && index === 0) output += '\\ ';
    else if (character.charCodeAt(0) < 0x20 || character.charCodeAt(0) > 0x7e) {
      output += `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    } else output += character;
  });
  return output;
}

function javaPropertiesTimestamp(date = new Date()): string {
  const [weekday, month, day, year, time] = date.toString().split(' ');
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
    .formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? 'UTC';
  return `${weekday} ${month} ${day} ${time} ${zone} ${year}`;
}

export function storeProperties(
  values: Record<string, string>,
  comment = javaPropertiesTimestamp(),
): Buffer {
  const lines = [`#${comment}`];
  Object.entries(values).forEach(([key, value]) => {
    lines.push(`${escapeProperty(key, true)}=${escapeProperty(value)}`);
  });
  return Buffer.from(`${lines.join('\n')}\n`, 'latin1');
}

function unescapeProperty(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, escaped: string) => {
    if (escaped.startsWith('u') && escaped.length === 5) {
      return String.fromCharCode(Number.parseInt(escaped.slice(1), 16));
    }
    return ({ t: '\t', n: '\n', r: '\r', f: '\f' } as Record<string, string>)[escaped]
      ?? escaped;
  });
}

export function loadProperties(data: Buffer | string): Record<string, string> {
  const text = Buffer.isBuffer(data) ? data.toString('latin1') : data;
  const result: Record<string, string> = {};
  let logical = '';
  for (const physical of text.split(/\r?\n/)) {
    logical += physical;
    if (logical.endsWith('\\') && !logical.endsWith('\\\\')) {
      logical = logical.slice(0, -1);
      continue;
    }
    const line = logical;
    logical = '';
    const stripped = line.trimStart();
    if (!stripped || stripped.startsWith('#') || stripped.startsWith('!')) continue;
    let split = -1;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '=' || character === ':' || /\s/.test(character)) {
        split = index;
        break;
      }
    }
    let key = split < 0 ? line : line.slice(0, split);
    let value = split < 0 ? '' : line.slice(split + 1).trimStart();
    if (value.startsWith('=') || value.startsWith(':')) value = value.slice(1).trimStart();
    key = unescapeProperty(key);
    result[key] = unescapeProperty(value);
  }
  return result;
}

class CxsTransport {
  private socket?: TLSSocket;
  private input = Buffer.alloc(0);
  private queue: CxsPacket[] = [];
  private waiters: Array<{
    resolve: (value: CxsPacket) => void;
    reject: (error: Error) => void;
  }> = [];
  private failure?: Error;

  async connect(host: string, addressIndex = 0): Promise<void> {
    this.close();
    this.failure = undefined;
    this.input = Buffer.alloc(0);
    this.queue = [];
    const addresses = (await resolve4(host)).sort();
    const address = addresses[addressIndex % addresses.length];
    if (!address) throw new Error(`CXS hostname did not resolve: ${host}`);
    await new Promise<void>((resolve, reject) => {
      const socket = tlsConnect({
        host: address,
        port: LOGIN_PORT,
        servername: LOGIN_HOST,
        rejectUnauthorized: true,
      });
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`CXS TLS timeout connecting to ${host}`));
      }, 10_000);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        if (process.env.MYQCAM_DEBUG_CXS) {
          console.error(
            `[cxs] ${host} -> ${socket.remoteAddress} ${socket.getProtocol()} `
            + `${socket.getCipher().name}`,
          );
        }
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        if (this.socket === socket) this.fail(error);
        reject(error);
      });
      socket.on('data', (chunk: Buffer) => this.receive(chunk));
      socket.once('close', () => {
        if (this.socket === socket) this.fail(new Error('CXS connection closed'));
      });
    });
  }

  private fail(error: Error): void {
    this.failure = error;
    const waiters = this.waiters.splice(0);
    waiters.forEach((waiter) => waiter.reject(error));
  }

  private receive(chunk: Buffer): void {
    this.input = Buffer.concat([this.input, chunk]);
    while (this.input.length >= FIXED_HEADER) {
      if (this.input[0] !== 0x41) {
        this.fail(new Error(`invalid CXS marker 0x${this.input[0].toString(16)}`));
        return;
      }
      const headerLength = this.input.readUInt16LE(2);
      const optionsLength = this.input.readUInt16LE(4);
      const bodyLength = this.input.readUInt32LE(7);
      const total = headerLength + bodyLength;
      if (headerLength < FIXED_HEADER + optionsLength || total > MAX_PACKET) {
        this.fail(new Error('invalid CXS packet lengths'));
        return;
      }
      if (this.input.length < total) return;
      const decoded = decodePacket(this.input.subarray(0, total));
      this.input = this.input.subarray(total);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(decoded);
      else this.queue.push(decoded);
    }
  }

  send(value: CxsPacket): void {
    if (!this.socket || this.socket.destroyed) throw new Error('CXS socket is not connected');
    this.socket.write(encodePacket(value));
  }

  async next(timeoutMs = 10_000): Promise<CxsPacket> {
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.failure) throw this.failure;
    return await new Promise<CxsPacket>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const done = (value: CxsPacket): void => {
        clearTimeout(timer);
        resolve(value);
      };
      const failed = (error: Error): void => {
        clearTimeout(timer);
        reject(error);
      };
      const waiter = { resolve: done, reject: failed };
      timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('timed out waiting for CXS packet'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket && !socket.destroyed) {
      socket.end();
      const force = setTimeout(() => socket.destroy(), 1_000);
      force.unref();
    }
  }
}

export class CxsConnection {
  private readonly transport = new CxsTransport();
  private frontDoorAddress = 0;
  options = Buffer.alloc(SESSION_OPTIONS_SIZE);
  properties: Record<string, string> = {};

  private loginPacket(accessToken: string): CxsPacket {
    const source = storeProperties({
      'partner-id': 'myQ',
      CX_UNAME: '',
      // Keep the proven legacy identity byte-for-byte; some brokers silently
      // drop otherwise valid logins carrying unfamiliar client labels.
      client_type: 'Python myqcam',
      sdk_version: '2.1.0.56',
      CX_PASSWD: `myQ.accessToken:${accessToken}`,
      current_version: '5.243.1.73243',
      os_name: 'Python',
      'app-id': 'com.chamberlain.android.liftmaster.myq',
      os_version: 'device-free',
    });
    const mode = storeProperties({ CX_UNAME: '', mode: '0' });
    return packet({ action: ACTION_LOGIN, source, body: Buffer.concat([mode, mode]) });
  }

  async login(accessToken: string): Promise<Record<string, string>> {
    const login = this.loginPacket(accessToken);
    await this.transport.connect(LOGIN_HOST, this.frontDoorAddress);
    this.frontDoorAddress += 1;
    this.transport.send(login);
    let redirect: CxsPacket;
    try {
      redirect = await this.transport.next(5_000);
    } catch (error) {
      throw new Error(`CXS front-door login failed: ${String(error)}`, { cause: error });
    }
    const redirectProperties = loadProperties(redirect.body);
    this.transport.close();
    let redirectHost: string | undefined = redirectProperties.redirectHost;
    if (!redirectHost) {
      const numbered = Object.entries(redirectProperties).find(([key]) => /^\d+$/.test(key));
      redirectHost = numbered?.[1]?.replace(/:\d+$/, '');
    }
    if (!redirectHost) throw new Error('Tend login did not return a broker');
    if (process.env.MYQCAM_DEBUG_CXS) console.error(`[cxs] redirect ${redirectHost}`);

    await this.transport.connect(redirectHost);
    // The legacy TLS 1.3 brokers can silently discard application data written
    // immediately from Node's secureConnect callback while post-handshake
    // session tickets are still arriving. Python's blocking SSL wrapper
    // naturally leaves this gap. Keep the proven packet identical and wait a
    // bounded moment before writing it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    this.transport.send(login);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let response: CxsPacket;
      try {
        response = await this.transport.next(5_000);
      } catch (error) {
        throw new Error(`CXS broker login failed: ${String(error)}`, { cause: error });
      }
      const properties = loadProperties(response.body);
      if (properties.sid || properties['session-id']) {
        this.options = Buffer.from(response.options);
        this.properties = properties;
        return properties;
      }
    }
    throw new Error('Tend broker login did not return session properties');
  }

  keepalive(): void {
    this.transport.send(packet({ action: ACTION_KEEPALIVE, options: this.options }));
  }

  sendCommand(command: string, destination: string, correlation?: string): string {
    const id = correlation ?? `LOG-${randomUUID().replaceAll('-', '')}`;
    this.transport.send(packet({
      action: ACTION_COMMAND,
      options: this.options,
      source: storeProperties({ CorrelationID: id, CX_DSTID: destination }),
      body: Buffer.from(command),
    }));
    return id;
  }

  async waitFor(prefixes: string[], timeoutMs = 15_000): Promise<CxsPacket> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await this.transport.next(deadline - Date.now());
      const text = response.body.toString('utf8');
      if (prefixes.some((prefix) => text.startsWith(prefix))) return response;
    }
    throw new Error(`timed out waiting for ${prefixes.join(', ')}`);
  }

  close(): void {
    this.transport.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TendClient {
  readonly cxs = new CxsConnection();
  private cameras: Camera[] = [];

  constructor(private readonly accessToken: string) {}

  async login(attempts = 3): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const properties = await this.cxs.login(this.accessToken);
        this.cameras = TendClient.parseCameras(properties);
        return;
      } catch (error) {
        last = error;
        this.cxs.close();
        if (attempt + 1 < attempts) await delay(3_000);
      }
    }
    throw last;
  }

  listCameras(): Camera[] {
    return [...this.cameras];
  }

  private static parseCapabilities(text: string): Record<string, string> {
    return Object.fromEntries(text.split('+').filter((item) => item.includes('='))
      .map((item) => item.split('=', 2) as [string, string]));
  }

  private static parseCameras(properties: Record<string, string>): Camera[] {
    const aliases = new Map<string, string>();
    for (const line of (properties['self-list'] ?? '').split(/\r?\n/)) {
      const fields = line.split(',');
      if (fields[0]?.includes(':') && fields.length >= 6) aliases.set(fields[0], fields[5]);
    }
    const cameras: Camera[] = [];
    for (const line of (properties['device-info-list'] ?? '').split(/\r?\n/)) {
      const comma = line.indexOf(',');
      if (comma < 0) continue;
      const destination = line.slice(0, comma);
      const separator = destination.indexOf(':');
      if (separator < 0) continue;
      const deviceId = destination.slice(0, separator);
      const mac = destination.slice(separator + 1);
      const raw = TendClient.parseCapabilities(line.slice(comma + 1));
      cameras.push({
        deviceId,
        alias: aliases.get(destination) ?? deviceId,
        mac: raw.MAC ?? mac,
        aesKey: raw.AES ?? '',
        online: raw.PWR_SLEEP_MODE !== 'DEEP',
        localIp: raw.LIP ?? '',
        localPort: Number(raw.LPORT ?? 0),
        cxsDestination: destination,
        raw,
      });
    }
    return cameras;
  }

  private connectionInfo(camera: Camera, offer: CxsPacket, correlation: string): ConnectionInfo {
    const relay = offer.source.toString('utf8').match(/rtp:\/\/([^:/]+):(\d+)/);
    const p2p = (this.cxs.properties['p2p-host'] ?? '').split(':');
    return {
      mode: camera.aesKey ? 9 : 8,
      peerIp: camera.localIp,
      peerPort: camera.localPort,
      relayHost: relay?.[1] ?? '',
      relayPort: Number(relay?.[2] ?? 0),
      p2pHost: p2p[0],
      p2pUdpPort: Number(p2p[1] ?? 0),
      p2pTcpPort: Number(p2p[2] ?? 0),
      aesKey: camera.aesKey,
      cxsDestination: camera.cxsDestination,
      correlation,
    };
  }

  async getVideoConnection(camera: Camera): Promise<ConnectionInfo> {
    const correlation = this.cxs.sendCommand(
      `require-video-send|${camera.deviceId}|9|`,
      camera.cxsDestination,
    );
    let offer: CxsPacket;
    try {
      offer = await this.cxs.waitFor(['accept-video-receive|']);
    } catch (error) {
      throw new Error(`camera video offer failed: ${String(error)}`, { cause: error });
    }
    return this.connectionInfo(camera, offer, correlation);
  }

  startVideo(camera: Camera, info: ConnectionInfo): void {
    this.cxs.sendCommand(
      `start-video-receive|${camera.deviceId}|9|`,
      camera.cxsDestination,
      info.correlation,
    );
  }

  stopVideo(camera: Camera, info: ConnectionInfo): void {
    this.cxs.sendCommand(
      `stop-video-receive|${camera.deviceId}|9|`,
      camera.cxsDestination,
      info.correlation,
    );
  }

  async getAudioConnection(camera: Camera): Promise<ConnectionInfo> {
    const sessionToken = `${camera.deviceId}:${Date.now()}`;
    const correlation = this.cxs.sendCommand(
      `require-audio-send|${camera.deviceId}|${sessionToken}|9|`,
      camera.cxsDestination,
    );
    let offer: CxsPacket;
    try {
      offer = await this.cxs.waitFor(['accept-audio-receive|']);
    } catch (error) {
      throw new Error(`camera audio offer failed: ${String(error)}`, { cause: error });
    }
    return { ...this.connectionInfo(camera, offer, correlation), sessionToken };
  }

  startAudio(camera: Camera, info: ConnectionInfo): void {
    this.cxs.sendCommand(
      `start-audio-receive|${camera.deviceId}|${info.sessionToken}|9|`,
      camera.cxsDestination,
      info.correlation,
    );
  }

  stopAudio(camera: Camera, info: ConnectionInfo): void {
    if (!info.sessionToken) throw new Error('audio connection is missing session token');
    this.cxs.sendCommand(
      `stop-audio-receive|${camera.deviceId}|${info.sessionToken}|9|`,
      camera.cxsDestination,
      info.correlation,
    );
  }

  setVideoQuality(camera: Camera, quality = 3, fps = 20, size = 0): void {
    this.cxs.sendCommand(
      `modify-device|${camera.deviceId}|QTY=${quality}+FPS=${fps}+SIZE=${size}+SAVE=0|`,
      camera.cxsDestination,
    );
  }

  close(): void {
    this.cxs.close();
  }
}
