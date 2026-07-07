# Changelog

All notable changes to `homebridge-myq-camera` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.11] - 2026-07-07

### Fixed
- Fixed a crash (`Cannot read properties of undefined (reading 'getVideoConnection')`)
  when HomeKit tore down a stream while the plugin was still retrying the video
  hole punch. The session now captures stable client/camera references and aborts
  the setup cleanly if it is closed mid-punch instead of dereferencing a nulled
  client.

## [0.2.10] - 2026-07-07

### Fixed
- Resolved `HomeKit stream failed: Seedonk hole punch timed out` on the first
  stream after a restart. HomeKit fetches a snapshot immediately before starting
  a stream; the plugin used to open a dedicated snapshot session for that, which
  took the camera's single viewer slot moments before the stream's hole punch
  and — because a TC camera needs time to release a viewer — made the punch time
  out. Snapshots are now served from a cached still that is refreshed from live
  streams and **persisted to the Homebridge storage directory**, so a restart no
  longer forces a cold snapshot session before a stream.

### Added
- Send an RTCP `BYE` on session teardown so the camera releases its single-viewer
  slot promptly instead of waiting out the receiver-report timeout.
- Retry the video hole punch with an inter-session cooldown as a safety net for
  back-to-back sessions.

### Changed
- Raised the HomeKit stream startup timeout to accommodate the punch-retry window.

## [0.2.9] - 2026-07-07

### Changed
- Hardened platform startup so a failure while publishing camera accessories is
  caught and logged instead of surfacing as an unhandled promise rejection.

### Docs
- Rewrote the install section for the published npm package (removed the stale
  local `.tgz` instructions) and added a **Getting your myQ token** bootstrap
  section explaining how to obtain the one-time OAuth refresh token.
- Added this changelog.

## [0.2.8] - 2026-07-06

### Changed
- Mirror the official myQ app's stream teardown by sending explicit CXS stop
  commands (`stop-video-receive` / `stop-audio-receive`) with the original
  stream correlations and session token before closing local RTP sockets.
- Releases the camera's one-viewer state promptly when HomeKit stops or abruptly
  exits a stream.

## [0.2.7] - 2026-07-06

### Changed
- Log HomeKit stream teardown reasons to make one-viewer contention and client
  disconnects easier to diagnose.

## [0.2.6] - 2026-07-06

### Added
- Stream startup diagnostics for clearer logging when a HomeKit stream fails to
  begin.

## [0.2.5] - 2026-07-06

### Fixed
- Config schema now uses JSON Schema-compliant object-level `required` arrays so
  the Homebridge Plugin Settings GUI validates correctly.

## [0.2.4] - 2026-07-06

### Added
- Plugin icon asset.

### Fixed
- Handle abrupt HomeKit stream teardown without leaking FFmpeg processes or
  native camera sessions.

## [0.2.3] - 2026-07-06

### Changed
- Prepared the plugin for Homebridge verification (metadata, engines, storage
  directory usage, and settings GUI).

## [0.2.2] - 2026-07-06

### Added
- Initial public release: native Homebridge camera accessory for legacy
  myQ / Tend / Seedonk **TC-series** cameras.
- H.264 video streaming to HomeKit.
- Camera microphone audio and HomeKit push-to-talk (talkback).
- Device-free OAuth refresh-token rotation, native CXS signaling, and SDNK LAN
  hole-punching — no phone, Python, or external media server required.

[0.2.11]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/KyleBoyer/homebridge-myq-camera/releases/tag/v0.2.2
