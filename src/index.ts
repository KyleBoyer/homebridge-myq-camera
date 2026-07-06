import type { API } from 'homebridge';
import { MyqCameraPlatform } from './platform';
import { PLATFORM_NAME, PLUGIN_NAME } from './types';

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MyqCameraPlatform);
};

export { MyqCameraPlatform } from './platform';
export { MyqCameraSession, TendConnectionManager } from './session';
export { TokenManager } from './auth';
export { CxsConnection, TendClient } from './cxs';
export { P2PMediaSession } from './p2p';
