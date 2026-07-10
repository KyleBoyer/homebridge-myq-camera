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
- A one-time myQ OAuth token file. The plugin stores and rotates it atomically
  under the Homebridge storage directory by default.

The default Homebridge FFmpeg dependency includes libx264, libopus, and libfdk_aac.
Do not configure a custom FFmpeg path unless you need one.

## Install

Install through the Homebridge UI (search for **myQ Camera**), or from the command line:

```bash
npm install -g homebridge-myq-camera
```

For local development from a checkout:

```bash
cd homebridge-myq-camera
npm install
npm test
npm pack
npm install -g ./homebridge-myq-camera-*.tgz
```

## Getting your myQ token

The plugin authenticates with a one-time myQ OAuth **refresh token**, then rotates it
itself forever with no phone involved. myQ enforces Firebase App Check / Play Integrity
only on the *initial* login, not on the refresh grant — which is why day-to-day operation
is device-free, but obtaining that first token requires one interaction with a
genuine, signed-in myQ app.

Create `<Homebridge storage>/myq-camera/token.json` (mode `0600`) containing at least a
valid refresh token:

```json
{"access_token": "", "refresh_token": "PASTE_YOUR_REFRESH_TOKEN"}
```

`access_token` may be left empty — the plugin exchanges the refresh token on first use and
stores the rotated result. To obtain the refresh token, extract it once from a logged-in
myQ app session on a rooted Android device — e.g. hook `javax.crypto.Cipher.doFinal` with
Frida and capture the 64-hex refresh token the app decrypts at launch. Guard this file —
it is a live account credential.

Place the token where the Homebridge service account can read and update it. By
default the plugin uses:

```text
<Homebridge storage>/myq-camera/token.json
```

For Homebridge OS / service installs this is commonly
`/var/lib/homebridge/myq-camera/token.json`. For a local development Homebridge
started without `-U`, it is usually `~/.homebridge/myq-camera/token.json`.

```bash
sudo mkdir -p /var/lib/homebridge/myq-camera
sudo cp token.json /var/lib/homebridge/myq-camera/token.json
sudo chown -R homebridge:homebridge /var/lib/homebridge/myq-camera
sudo chmod 700 /var/lib/homebridge/myq-camera
sudo chmod 600 /var/lib/homebridge/myq-camera/token.json
```

If your Homebridge uses a different storage path, copy the token there instead,
or set `tokenFile` explicitly in the plugin config.

## Validate before pairing

Run from the Homebridge terminal:

```bash
homebridge-myq-camera-doctor
homebridge-myq-camera-doctor --live 30
```

If your storage path is not the default `~/.homebridge`, pass it explicitly:

```bash
homebridge-myq-camera-doctor --storage-path /var/lib/homebridge --live 30
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
  "tokenFile": "",
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

The camera itself allows one live viewer, so the plugin holds a **single shared session**
that every snapshot and every HomeKit stream multiplexes over. This dissolves the classic
snapshot→stream hole-punch collision (they no longer compete), keeps snapshots fresh
straight off the live feed, and lets **multiple HomeKit clients watch at once** (phone +
iPad) even though the camera only serves one viewer directly.

The session is opened on demand (a snapshot or stream request) and kept warm for
`keepAliveSeconds` (default 60) after the last one finishes, so a follow-up request reuses
it instantly instead of re-punching. While warm, the plugin keeps the latest decodable
H.264 keyframe bundle (`SPS`/`PPS`/`IDR`) so snapshot capture can start immediately from
the current feed. Snapshots are persisted to the storage directory so a restart is never
blank; when the shared session is open, or when a closed-session snapshot is older than
`snapshotRefreshInterval` seconds (default 15), HomeKit waits for a fresh still rather
than getting the previous poll's cached image. Set `snapshotRefreshInterval` to `0` to
refresh on every snapshot request. `maxViewers` caps concurrent streams (default `0` =
unlimited, mapped to 8 since HomeKit needs a concrete count).

Advanced timing knobs are available when a camera or relay is slow to release:
`snapshotTimeoutSeconds` (default 15), `streamStartupTimeoutSeconds` (default 45),
`videoPunchTimeoutSeconds` (default 8 per attempt), `videoPunchAttempts` (default 2),
`videoPunchRetryDelaySeconds` (default 4), and `interSessionCooldownSeconds` (default 3).
The defaults are intentionally conservative; only raise them if logs show the camera is
still completing a later retry after HomeKit gives up.

Push-to-talk return audio is decrypted from HomeKit SRTP by FFmpeg, converted once to
8 kHz μ-law, and injected into the existing Seedonk audio channel. Camera audio travels
the opposite direction without an intermediate lossy AAC hop.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Scope

For interoperability with cameras and accounts you own. This project is not affiliated
with Chamberlain, LiftMaster, myQ, Tend, or Seedonk.
