# homebridge-myq-camera

Native Homebridge camera support for legacy myQ **TC-series** cameras built on the
Tend/Seedonk stack. It runs entirely in Node.js/TypeScript: no phone, Android emulator,
Python runtime, go2rtc, or separate media server is required.

## Features

- Device-free OAuth refresh-token rotation.
- Native CXS TLS signaling and SDNK LAN hole-punching.
- AES-decrypted 1280×720 H.264 video.
- Correct 8 kHz G.711 μ-law camera audio.
- RTCP receiver reports for long-running audio.
- HomeKit Secure RTP output through Homebridge's maintained FFmpeg bundle.
- HomeKit push-to-talk routed into the same camera session.
- Snapshot caching and single-session serialization.

Only older cameras whose serial starts with `TC` are supported. Newer myQ
WebRTC/Amazon-KVS cameras use an unrelated protocol.

## Requirements

- Homebridge 1.8+ or 2.x on Node 22 or 24.
- The Homebridge host must be on the same LAN as the camera.
- A one-time myQ OAuth token file. The plugin rotates the refresh token atomically.

The default Homebridge FFmpeg dependency includes libx264, libopus, and libfdk_aac.
Do not configure a custom FFmpeg path unless you need one.

## Install

During local development:

```bash
cd homebridge-myq-camera
npm install
npm test
npm pack
npm install -g ./homebridge-myq-camera-0.2.2.tgz
```

Once published:

```bash
npm install -g homebridge-myq-camera
```

Place the token where the Homebridge service account can read and update it:

```bash
mkdir -p ~/.config/myqcam
cp token.json ~/.config/myqcam/token.json
chmod 700 ~/.config/myqcam
chmod 600 ~/.config/myqcam/token.json
```

For a service installation, `~` means the Homebridge service user's home (commonly
`/var/lib/homebridge`). The token file must be writable because myQ rotates refresh
tokens.

## Validate before pairing

Run from the Homebridge terminal:

```bash
homebridge-myq-camera-doctor
homebridge-myq-camera-doctor --live 30
```

The live check must report both H.264 and μ-law frames. An optional audible talkback
test is:

```bash
homebridge-myq-camera-doctor --live 10 --talk /path/to/speech.wav
```

## Configuration

```json
{
  "platform": "MyqCamera",
  "name": "myQ Camera",
  "tokenFile": "~/.config/myqcam/token.json",
  "audio": true,
  "talkback": true,
  "copyVideo": false,
  "cameras": [
    {
      "name": "Garage Camera",
      "deviceId": ""
    }
  ],
  "_bridge": {
    "username": "0E:31:AB:12:34:56",
    "port": 51852
  }
}
```

Leave `deviceId` empty to select the first TC-series camera. Use either its myQ alias or
full Tend device ID when an account has multiple cameras.

A child bridge is strongly recommended. It isolates camera/FFmpeg failures and gives the
camera its own HomeKit pairing QR code.

`copyVideo: false` re-encodes to the exact HomeKit-requested resolution and bitrate.
`copyVideo: true` avoids video encoding and advertises only the camera's native
1280×720/20 fps mode.

## Operational behavior

The camera allows one live viewer. The plugin holds one native session for each HomeKit
stream and routes video, camera audio, RTCP, and talkback through it. Snapshots are
serialized; while live video is active HomeKit receives the last cached snapshot.

Push-to-talk return audio is decrypted from HomeKit SRTP by FFmpeg, converted once to
8 kHz μ-law, and injected into the existing Seedonk audio channel. Camera audio travels
the opposite direction without an intermediate lossy AAC hop.

## Scope

For interoperability with cameras and accounts you own. This project is not affiliated
with Chamberlain, LiftMaster, myQ, Tend, or Seedonk.
