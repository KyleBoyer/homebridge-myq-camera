import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
} from 'homebridge';
import bundledFfmpeg from 'ffmpeg-for-homebridge';
import { expandHome, TokenManager } from './auth';
import { TendConnectionManager } from './session';
import { StreamingDelegate } from './streamingDelegate';
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  type CameraConfig,
  type MyqPlatformConfig,
} from './types';

export class MyqCameraPlatform implements DynamicPlatformPlugin {
  private readonly accessories: PlatformAccessory[] = [];
  private readonly delegates: StreamingDelegate[] = [];
  private readonly tokens: TokenManager;
  private readonly connection: TendConnectionManager;
  private readonly ffmpeg: string;
  private readonly tokenFile: string;
  private readonly legacyDefaultTokenFile?: string;

  constructor(
    private readonly log: Logger,
    private readonly config: MyqPlatformConfig,
    private readonly api: API,
  ) {
    const configuredTokenFile = config?.tokenFile?.trim();
    this.tokenFile = configuredTokenFile
      || join(api.user.storagePath(), 'myq-camera', 'token.json');
    this.legacyDefaultTokenFile = configuredTokenFile
      ? undefined
      : expandHome('~/.config/myqcam/token.json');
    this.tokens = new TokenManager(this.tokenFile);
    this.connection = new TendConnectionManager(this.tokens, log);
    this.ffmpeg = config?.ffmpeg?.trim() || bundledFfmpeg || 'ffmpeg';
    if (!config) {
      this.log.warn('Ignoring homebridge-myq-camera because it is not configured');
      return;
    }
    api.on('didFinishLaunching', () => void this.launch());
    api.on('shutdown', () => {
      this.delegates.forEach((delegate) => delegate.shutdown());
      this.connection.close();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
  }

  private async validateRuntime(): Promise<void> {
    const tokenPath = expandHome(this.tokenFile);
    if (!existsSync(tokenPath) && this.legacyDefaultTokenFile
      && existsSync(this.legacyDefaultTokenFile)) {
      await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
      await copyFile(this.legacyDefaultTokenFile, tokenPath);
      await chmod(tokenPath, 0o600);
      this.log.warn(
        `Migrated legacy myQ token file to Homebridge storage: ${tokenPath}. `
        + 'You can remove the old ~/.config/myqcam/token.json file after confirming startup.',
      );
    }
    if (!existsSync(tokenPath)) {
      throw new Error(`OAuth token file not found: ${tokenPath}`);
    }
    await this.tokens.validate();
    const result = spawnSync(this.ffmpeg, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`ffmpeg is unavailable at ${this.ffmpeg}: ${result.error?.message ?? result.stderr}`);
    }
    if (!result.stdout.includes('libx264')) throw new Error('ffmpeg lacks the libx264 encoder');
    if (this.config.audio !== false && !result.stdout.includes('libopus')
      && this.config.talkback === false) {
      throw new Error('ffmpeg lacks the libopus encoder');
    }
    if (
      this.config.audio !== false
      && this.config.talkback !== false
      && !result.stdout.includes('libfdk_aac')
    ) {
      throw new Error(
        'two-way audio requires libfdk_aac; remove the ffmpeg override to use '
        + 'the bundled Homebridge ffmpeg, or set talkback=false',
      );
    }
  }

  private async launch(): Promise<void> {
    try {
      await this.validateRuntime();
    } catch (error) {
      this.log.error(`myQ Camera startup check failed: ${String(error)}`);
      return;
    }
    const cameras: CameraConfig[] = this.config.cameras?.length
      ? this.config.cameras
      : [{ name: this.config.name || 'myQ Camera' }];
    const expected = new Set<string>();

    for (const cameraConfig of cameras) {
      const name = cameraConfig.name || 'myQ Camera';
      const uuid = this.api.hap.uuid.generate(
        `${PLUGIN_NAME}:${name}:${cameraConfig.deviceId || 'default'}`,
      );
      expected.add(uuid);
      let accessory = this.accessories.find((candidate) => candidate.UUID === uuid);
      const isNew = !accessory;
      if (!accessory) {
        accessory = new this.api.platformAccessory(name, uuid);
        accessory.category = this.api.hap.Categories.CAMERA;
      }
      accessory.context.cameraConfig = cameraConfig;
      accessory.getService(this.api.hap.Service.AccessoryInformation)
        ?.setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'Chamberlain (myQ/Tend)')
        .setCharacteristic(this.api.hap.Characteristic.Model, 'TC-series camera')
        .setCharacteristic(
          this.api.hap.Characteristic.SerialNumber,
          cameraConfig.deviceId || `myq-tc-${uuid.slice(0, 8)}`,
        );
      const delegate = new StreamingDelegate(
        this.api.hap,
        this.log,
        this.config,
        cameraConfig,
        this.connection,
        this.ffmpeg,
        this.api,
      );
      this.delegates.push(delegate);
      accessory.configureController(delegate.controller);
      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
      this.log.info(`Configured native myQ camera: ${name}`);
    }

    const stale = this.accessories.filter((accessory) => !expected.has(accessory.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach((accessory) => {
        const index = this.accessories.indexOf(accessory);
        if (index >= 0) this.accessories.splice(index, 1);
      });
    }
    // Warm the one long-lived broker session before HomeKit asks for a snapshot.
    void this.connection.connect().catch((error) => {
      this.log.warn(`Initial myQ signaling connection failed; will retry on demand: ${String(error)}`);
    });
  }
}
