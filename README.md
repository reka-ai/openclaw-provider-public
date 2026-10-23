# Reka for OpenClaw

A community provider plugin that adds Reka to [OpenClaw](https://docs.openclaw.ai): native API-key sign-in, a model picker fed by Reka's live `/v1/models`, and DeepSeek 4 Flash as the recommended default.

```sh
openclaw plugins install clawhub:openclaw-reka-provider
```

- **Users:** follow [docs/SETUP.md](docs/SETUP.md).
- **Plugin details** (models, reasoning, config): [plugin/README.md](plugin/README.md). Changes: [plugin/CHANGELOG.md](plugin/CHANGELOG.md).
- **Security issues:** see [SECURITY.md](SECURITY.md).

## Layout

| Path | What it is |
| --- | --- |
| `plugin/` | The publishable package: `index.js`, `src/`, `catalog/reka-models.json` (bundled snapshot), manifest and tests |
| `runtime/` | A pinned OpenClaw host (`openclaw@2026.10.6`, locked) and the suites that install and run the plugin in it |
| `scripts/refresh-catalog.mjs` | Rewrites the bundled snapshot from `GET /v1/models` |
| `docs/` | The setup guide and its screenshots |

## Development

Use Node 24.22.1+ (within 24.x) or 26.12.1+, which the pinned OpenClaw 2026.10.6 requires. CI runs Node 24 and 26.12.1 on Linux and macOS, and repeats the suites on OpenClaw 2026.10.2, the oldest version the plugin supports.

```sh
npm run setup              # npm ci --ignore-scripts (root ClawHub CLI, then the pinned host); links plugin/node_modules
npm test                   # plugin unit/transport tests, then the four pinned-host suites
npm run clawhub:validate   # ClawHub's Plugin Inspector, static; does not run plugin code
```

Tests use dummy keys and loopback servers only; they never call Reka or read a real key. The host suites also run OpenClaw in temporary profiles with their own `HOME`. The unit tests write nothing, though the SDK may read your `~/.openclaw` folder. Keep it that way: no real keys in tests, fixtures, logs or screenshots.

The host suites cover loading from source, installing the packed archive, OpenClaw's managed `npm-pack:` install, and an agent run against a loopback stand-in for `api.reka.ai` (live `/v1/models` listing, a tool call, a continuation turn, and a model used by id that is only in the live list).

CI (`.github/workflows/ci.yml`) also runs ClawHub's Plugin Inspector against the tested and latest OpenClaw, and a publish dry run.

## Model catalog

The plugin reads the live list at runtime, so new Reka models appear without a release. The bundled snapshot is the starter list and the offline fallback. OpenClaw keeps showing starter models until a release replaces the snapshot, so refresh it before each release.

To refresh it by hand (needs a Reka key; listing is not billed). `read -s` keeps the key off screen and out of shell history:

```sh
read -rs REKA_API_KEY && export REKA_API_KEY
npm run refresh-catalog
```

`.github/workflows/catalog-refresh.yml` does this weekly and opens a PR when the list changes. It is a no-op until the `REKA_CATALOG_API_KEY` repository secret is set. Use a key from an ordinary customer account, so the snapshot that ships in the package lists only models customers can use. PRs it opens with `GITHUB_TOKEN` do not start CI on their own; run CI on the branch before merging.

## Releasing

Releases publish to ClawHub as `openclaw-reka-provider` under the `reka-ai` owner, from `.github/workflows/release.yml`. ClawHub keeps a new release hidden until its security checks and verification finish.

One-time setup:

1. A maintainer signs in with their own account (`npx clawhub login`) and creates the org publisher: `npx clawhub publisher create reka-ai --display-name "Reka"`. Add other maintainers to the org on ClawHub instead of sharing a login.
2. In this repository's settings, create the `release` environment with required reviewers, and add the environment secret `CLAWHUB_TOKEN`. Use a dedicated token created in ClawHub Settings → API tokens, so it can be revoked without signing anyone out.

Each release:

1. Bump `version` in `plugin/package.json` and `plugin/openclaw.plugin.json`, date its entry in `plugin/CHANGELOG.md` (`## [x.y.z] - YYYY-MM-DD`), and refresh the snapshot (above).
2. Merge to `main` with CI green, then tag that commit: `git tag vx.y.z && git push origin vx.y.z`.
3. The release workflow checks the tag against both versions and the changelog, runs the tests and the Plugin Inspector, then publishes with the source repo, commit and ref, and waits for ClawHub's checks.
4. Install the listing into fresh OpenClaw state (`openclaw plugins install clawhub:openclaw-reka-provider`) and send one message before announcing it.

To preview a release by hand, run `npm run clawhub:dry-run`; nothing is uploaded.

After the first publish, ClawHub can trust the workflow through GitHub OIDC instead of a stored token: `npx clawhub package trusted-publisher set openclaw-reka-provider --repository reka-ai/openclaw-provider-public --workflow-filename release.yml --environment release`.

A ClawHub listing makes the plugin installable and searchable; it does not add Reka to OpenClaw's built-in provider list. That is a separate conversation with the OpenClaw maintainers.
