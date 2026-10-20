# Changelog

All notable changes to this plugin are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First public release.

### Added

- Reka as an OpenClaw provider: API-key sign-in at OpenClaw's masked prompt (`REKA_API_KEY` or `--reka-api-key`), with DeepSeek 4 Flash as the recommended default.
- A model list read from Reka's `GET /v1/models` with your key, so new Reka models appear without a plugin release. Only ready, tool-capable chat models are offered. Listing is free; it is not an inference call.
- A bundled snapshot of the list for starter models and offline fallback.
- Dynamic model resolution: any well-formed `reka/<model-id>` works by id, including models Reka lists after this release.
- Per-model reasoning support: `reasoning_effort` is sent only to models that declare reasoning, using Reka's documented levels.
- Supports OpenClaw 2026.10.2 and newer, on Node 24.16+ (within 24.x) or 26.1+.
