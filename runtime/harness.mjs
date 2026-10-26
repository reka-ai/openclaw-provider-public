// Shared setup for the pinned-host suites. Every suite uses a fresh temporary
// OpenClaw profile, a dummy key and loopback-only endpoints.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const runtime = path.dirname(fileURLToPath(import.meta.url));
export const project = path.dirname(runtime);
export const plugin = path.join(project, 'plugin');

/** OpenClaw version installed in runtime/node_modules: the locked pin, or the one CI swaps in. */
export const hostVersion = JSON.parse(readFileSync(path.join(runtime, 'node_modules', 'openclaw', 'package.json'), 'utf8')).version;

/** Model ids the bundled snapshot offers (tool-capable rows). */
export function snapshotIds() {
  const snapshot = JSON.parse(readFileSync(path.join(plugin, 'catalog', 'reka-models.json'), 'utf8'));
  return snapshot.data.filter((row) => row.supported_features?.includes('tools')).map((row) => row.id);
}

/** Fresh profile with its own HOME so nothing touches the user's OpenClaw state. */
export function isolatedProfile(name, config, extraEnv = {}) {
  const state = mkdtempSync(path.join(tmpdir(), `reka-openclaw-${name}-`));
  const configPath = path.join(state, 'openclaw.json');
  writeFileSync(configPath, JSON.stringify(config(state), null, 2), { mode: 0o600 });
  const env = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    HOME: state,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    REKA_OPENCLAW_NODE: process.execPath,
    OPENCLAW_NO_BANNER: '1',
    NO_COLOR: '1',
    ...extraEnv,
  };
  return { state, configPath, env };
}

export function openclaw(profile, args, { timeout = 120_000 } = {}) {
  const result = spawnSync(path.join(runtime, 'openclaw'), args, {
    env: profile.env, cwd: profile.state, encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `openclaw ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

/** CLI diagnostics can precede the JSON result. */
export function cliJson(output) {
  for (const start of [...output.matchAll(/^[\[{]/gm)].map((match) => match.index)) {
    try { return JSON.parse(output.slice(start)); } catch {}
  }
  throw new Error(`CLI returned no parseable JSON:\n${output}`);
}

/** Packs the plugin source exactly as npm would publish it. */
export function packPlugin() {
  const destination = mkdtempSync(path.join(tmpdir(), 'reka-openclaw-pack-'));
  const npm = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const result = spawnSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
    cwd: plugin, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: destination, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  assert.equal(result.status, 0, `npm pack failed:\n${result.stderr}`);
  const [packed] = JSON.parse(result.stdout);
  assert.deepEqual(packed.files.map((file) => file.path).sort(), [
    'CHANGELOG.md', 'LICENSE', 'README.md', 'assets/icon.png', 'catalog/reka-models.json', 'index.js', 'openclaw.plugin.json', 'package.json', 'src/catalog.js', 'src/provider.js', 'src/usage.js',
  ]);
  return path.join(destination, packed.filename);
}
