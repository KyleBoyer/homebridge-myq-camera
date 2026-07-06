#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import bundledFfmpeg from 'ffmpeg-for-homebridge';
import { expandHome, TokenManager } from './auth';
import { MyqCameraSession, TendConnectionManager } from './session';
import { consoleLogger } from './types';

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main(): Promise<void> {
  const tokenFile = argument('--token-file', '~/.config/myqcam/token.json')!;
  const camera = argument('--camera');
  const liveSeconds = Number(argument('--live', '0'));
  const talkFile = argument('--talk');
  const ffmpeg = argument('--ffmpeg') || bundledFfmpeg || 'ffmpeg';
  const expanded = expandHome(tokenFile);

  console.log(`Node: ${process.version}`);
  console.log(`Token: ${expanded}`);
  if (!existsSync(expanded)) throw new Error('token file does not exist');
  const tokens = new TokenManager(tokenFile);
  await tokens.validate();
  console.log('Token JSON: OK');

  const check = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (check.error || check.status !== 0) throw check.error ?? new Error(check.stderr);
  for (const encoder of ['libx264', 'libopus', 'libfdk_aac']) {
    if (!check.stdout.includes(encoder)) throw new Error(`ffmpeg lacks ${encoder}`);
  }
  console.log(`FFmpeg: ${ffmpeg}`);
  console.log('FFmpeg encoders: OK (libx264, libopus, libfdk_aac)');

  if (liveSeconds > 0) {
    const connection = new TendConnectionManager(tokens, consoleLogger);
    const session = new MyqCameraSession(connection, consoleLogger, { camera, audio: true });
    let videoFrames = 0;
    let audioFrames = 0;
    let videoBytes = 0;
    let audioBytes = 0;
    session.on('video', (frame: Buffer) => {
      videoFrames += 1;
      videoBytes += frame.length;
    });
    session.on('audio', (frame: Buffer) => {
      audioFrames += 1;
      audioBytes += frame.length;
    });
    try {
      await session.open();
      let talkProcess: ChildProcess | undefined;
      if (talkFile) {
        talkProcess = spawn(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-i', talkFile,
          '-af', 'highpass=f=120,lowpass=f=3400,loudnorm=I=-16:TP=-1.5:LRA=7,'
            + 'aresample=8000:resampler=swr:filter_size=64:phase_shift=10:'
            + 'exact_rational=1:cutoff=0.95:dither_method=triangular_hp',
          '-ac', '1', '-f', 'mulaw', 'pipe:1',
        ]);
        talkProcess.stdout?.on('data', (data: Buffer) => session.writeTalkback(data));
        console.log(`Talkback probe: ${talkFile}`);
      }
      await new Promise((resolve) => setTimeout(resolve, liveSeconds * 1000));
      talkProcess?.kill('SIGKILL');
    } finally {
      session.close();
      connection.close();
    }
    console.log(
      `Live probe: ${videoFrames} H.264 frames/${videoBytes} bytes, `
      + `${audioFrames} μ-law frames/${audioBytes} bytes`,
    );
    if (!videoFrames) throw new Error('live probe received no video');
    if (!audioFrames) throw new Error('live probe received no audio');
  }
  console.log('homebridge-myq-camera doctor: PASS');
}

main().catch((error) => {
  console.error(`homebridge-myq-camera doctor: FAIL: ${String(error)}`);
  process.exitCode = 1;
});
