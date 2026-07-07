import type { Logger, PlatformConfig } from 'homebridge';

export const PLUGIN_NAME = 'homebridge-myq-camera';
export const PLATFORM_NAME = 'MyqCamera';

export interface CameraConfig {
  name: string;
  deviceId?: string;
}

export interface MyqPlatformConfig extends PlatformConfig {
  tokenFile?: string;
  ffmpeg?: string;
  audio?: boolean;
  talkback?: boolean;
  copyVideo?: boolean;
  debug?: boolean;
  snapshotRefreshInterval?: number;
  cameras?: CameraConfig[];
}

export interface Camera {
  deviceId: string;
  alias: string;
  mac: string;
  aesKey: string;
  online: boolean;
  localIp: string;
  localPort: number;
  cxsDestination: string;
  raw: Record<string, string>;
}

export interface ConnectionInfo {
  mode: number;
  peerIp: string;
  peerPort: number;
  relayHost: string;
  relayPort: number;
  p2pHost?: string;
  p2pUdpPort?: number;
  p2pTcpPort?: number;
  aesKey: string;
  cxsDestination: string;
  correlation: string;
  sessionToken?: string;
}

export type PluginLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

export const consoleLogger: PluginLogger = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
};
