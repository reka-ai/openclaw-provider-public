# Changelog

All notable changes to this plugin are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Your Reka balance in `openclaw status --usage` and OpenClaw's other usage views. With a Reka Pass, it also shows the share of this month's Pass credit left and the renewal date. Read with your API key from `https://developer.reka.ai/api/v1/credits`; free, not an inference call, and cached for a minute.

## [0.1.0] - Unreleased

First public release.

### Added

- Reka as an OpenClaw provider: API-key sign-in at OpenClaw's masked prompt (`REKA_API_KEY` or `--reka-api-key`), with DeepSeek 4 Flash as the recommended default.
- A model list read from Reka's `GET /v1/models` with your key, so new Reka models appear without a plugin release. Only ready, tool-capable chat models are offered. Listing is not an inference call and is not billed.
- A bundled snapshot of the list for starter models and offline fallback.
- Dynamic model resolution: any well-formed `reka/<model-id>` works by id, including models Reka lists after this release.
- Per-model reasoning support: `reasoning_effort` is sent only to models that declare reasoning, using Reka's documented levels.
- Supports OpenClaw 2026.10.2 and newer; tested with 2026.10.2 and 2026.10.6. The plugin runs on Node 24.16+ (within 24.x) or 26.1+; newer OpenClaw releases can require a newer Node.
