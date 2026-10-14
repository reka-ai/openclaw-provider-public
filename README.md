# Reka for OpenClaw

A community provider plugin that adds Reka to [OpenClaw](https://docs.openclaw.ai): native API-key sign-in, a model picker fed by Reka's live `/v1/models`, and DeepSeek 4 Flash as the recommended default.

- **Users:** follow [docs/SETUP.md](docs/SETUP.md).
- **Plugin details** (models, reasoning, config): [plugin/README.md](plugin/README.md).

## Layout

| Path | What it is |
| --- | --- |
| `plugin/` | The publishable package: `index.js`, `src/`, `catalog/reka-models.json` (bundled snapshot), manifest and tests |
| `runtime/` | A pinned OpenClaw host (`openclaw@2026.10.2`, locked) and the suites that install and run the plugin in it |
| `scripts/refresh-catalog.mjs` | Rewrites the bundled snapshot from `GET /v1/models` |
| `docs/` | The setup guide and its screenshots |

## Development

Use Node 24.16+ (within 24.x) or 26.1+. CI runs Node 24 and 26.8.1 on Linux and macOS.

```sh
npm run setup   # npm ci --ignore-scripts for the pinned host, then links plugin/node_modules to it
npm test        # plugin unit/transport tests, then the four pinned-host suites
```

Tests use dummy keys and loopback servers only; they never call Reka or read a real key. The host suites also run OpenClaw in temporary profiles with their own `HOME`. The unit tests write nothing, though the SDK may read your `~/.openclaw` folder. Keep it that way: no real keys in tests, fixtures, logs or screenshots.

The host suites cover loading from source, installing the packed archive, OpenClaw's managed `npm-pack:` install, and an agent run against a loopback stand-in for `api.reka.ai` (live `/v1/models` listing, a tool call, and a continuation turn).

## Model catalog

The plugin reads the live list at runtime, so new Reka models appear without a release. The bundled snapshot is the starter list and the offline fallback. OpenClaw keeps showing starter models until a release replaces the snapshot, so refresh it before each release.

To refresh it by hand (needs a Reka key; listing is not billed). `read -s` keeps the key off screen and out of shell history:

```sh
read -rs REKA_API_KEY && export REKA_API_KEY
npm run refresh-catalog
```

`.github/workflows/catalog-refresh.yml` does this weekly and opens a PR when the list changes. It is a no-op until the `REKA_CATALOG_API_KEY` repository secret is set. Use a key from an ordinary customer account, so the snapshot that ships in the package lists only models customers can use. PRs it opens with `GITHUB_TOKEN` do not start CI on their own; run CI on the branch before merging.

## Releasing

The plugin is published on ClawHub by the `reka` owner as `@reka/openclaw-provider` under the MIT license. ClawHub keeps a new release hidden until its security checks and verification finish.

1. Bump `version` in `plugin/package.json` and `plugin/openclaw.plugin.json`, refresh the snapshot (above), and make sure CI is green on the release commit.
2. From a clean checkout of that commit, validate and preview:

   ```sh
   clawhub package validate ./plugin
   clawhub package publish ./plugin --owner reka --source-repo reka-ai/openclaw-provider-public --source-commit "$(git rev-parse HEAD)" --source-path plugin --dry-run
   ```

3. Publish the same command without `--dry-run`, adding `--wait` to block until ClawHub's checks finish.
4. Install the listing into fresh OpenClaw state (`openclaw plugins install clawhub:@reka/openclaw-provider`) and send one message before announcing it.

A ClawHub listing makes the plugin installable and searchable; it does not add Reka to OpenClaw's built-in provider list. That is a separate conversation with the OpenClaw maintainers.
