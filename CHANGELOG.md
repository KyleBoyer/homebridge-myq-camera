# Changelog

All notable changes to `homebridge-myq-camera` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] - 2026-07-10

### Added
- More lifecycle logging for snapshot requests, snapshot refresh decisions,
  snapshot completion/failure, HomeKit stream STOP/cleanup, shared-session
  acquisition, hole-punch attempts, retry delays, final hole-punch failures, and
  inter-session cooldown waits.
- Advanced timing options for slow cameras/relays:
  - `snapshotTimeoutSeconds` (default `15`)
  - `streamStartupTimeoutSeconds` (default `45`)
  - `videoPunchTimeoutSeconds` (default `8`)
  - `videoPunchAttempts` (default `2`)
  - `videoPunchRetryDelaySeconds` (default `4`)
  - `interSessionCooldownSeconds` (default `3`)

### Changed
- If HomeKit stops a stream while startup is still waiting for the shared camera
  session, the plugin now releases that pending consumer immediately. When no
  consumers remain, the shared session cancels the pending camera open so
  hole-punch retries do not continue invisibly after HomeKit has already bailed.

## [0.3.2] - 2026-07-09

### Changed
- `snapshotRefreshInterval: 0` now means "refresh on every snapshot request."
  With the singleton shared camera session, a cold snapshot request can safely
  open/warm the stream because a follow-up live view reuses that same session
  instead of colliding with a separate snapshot session.
- Nonzero `snapshotRefreshInterval` values keep their threshold behavior: a
  closed-session snapshot request refreshes once the cached still is older than
  the configured number of seconds, while open/warm sessions always refresh from
  the latest warm keyframe.

## [0.3.1] - 2026-07-08

### Changed
- While the shared session is warm, the plugin now caches the latest decodable
  H.264 keyframe bundle (`SPS`/`PPS`/`IDR`) so snapshot capture can start from a
  current keyframe immediately instead of waiting for the next IDR.
- Snapshot requests now block for a fresh still whenever the shared camera
  session is already open or the closed-session snapshot cache is stale. This
  trades a short wait for a current tile, prevents post-live-view snapshots from
  lagging one HomeKit poll behind, and warms the camera for a likely follow-up
  live view.
- When a HomeKit live stream stops, the plugin now starts a best-effort snapshot
  capture immediately while the shared feed is still warm, instead of waiting
  until the keep-alive idle timer is about to close the session.

## [0.3.0] - 2026-07-08

### Changed
- **Snapshots and live streams now share one camera session.** The TC camera
  serves a single viewer, so instead of snapshots and streams opening competing
  sessions (the source of the earlier hole-punch collisions), they all multiplex
  a single reference-counted `SharedCameraSession`. This removes the snapshot→
  stream collision entirely, so the staleness debounce/TTL heuristic is gone —
  snapshots are served instantly from cache and refreshed straight off the live
  feed. A warm session also means a follow-up snapshot or stream starts instantly
  (no re-punch).

### Added
- **Multiple concurrent HomeKit viewers.** Because every viewer shares the one
  session, the camera's single-viewer limit no longer caps us. New `maxViewers`
  option (default `0` = unlimited; HomeKit needs a concrete count, so mapped to 8).
  Each viewer/snapshot gets its own keyframe gate seeded with the session's
  SPS/PPS, so a viewer joining a stream in progress starts on a clean IDR instead
  of black video.
- `keepAliveSeconds` (default `60`): how long the shared session stays warm after
  the last snapshot/stream finishes, so a follow-up request reuses it instantly.
- Snapshots refresh off the live feed while the session is open (streaming **or**
  in the warm window) as a passive read that doesn't extend the keep-alive, and a
  final still is captured right before the warm session idles out so the tile is
  current afterward.
- `snapshotRefreshInterval` (default `15`s) now controls when a snapshot request
  opens a *closed* session to refresh a stale still; `0` = only refresh while a
  session is already open.

## [0.2.13] - 2026-07-07

### Fixed
- Fixed a 0.2.12 regression where the persisted snapshot loaded as *stale*, so
  the first tile poll after a restart spawned a background snapshot session that
  competed with — and failed — the stream a user started moments later (`camera
  session closed during video setup` / `Seedonk hole punch timed out`). The
  snapshot now loads fresh, and background refreshes are debounced to fire only
  after the tile has been viewed continuously for a while, never in the
  open-app-then-start-stream window.

## [0.2.12] - 2026-07-07

### Added
- Background snapshot refresh so cached stills don't go stale between streams.
  When HomeKit polls a visible camera tile and the cached snapshot is older than
  the refresh interval, the plugin fetches a fresh still in the background (the
  tile keeps showing the cached image until the new one is ready — the response
  is never blocked). New `snapshotRefreshInterval` option (seconds, default 120;
  set to 0 to only refresh while streaming). A persisted snapshot loads as stale
  so the first view after a restart pulls a current frame.

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

[0.3.3]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.2.13...v0.3.0
[0.2.13]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/KyleBoyer/homebridge-myq-camera/compare/v0.2.11...v0.2.12
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
