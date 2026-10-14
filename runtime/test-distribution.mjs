// Installs the packed archive directly, then loads it without the source checkout.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cliJson, isolatedProfile, openclaw, packPlugin, snapshotIds } from './harness.mjs';

const archive = packPlugin();
const profile = isolatedProfile('distribution', (state) => ({
  gateway: { mode: 'local', bind: 'loopback' },
  plugins: { slots: { memory: 'none' } },
  agents: { defaults: { workspace: path.join(state, 'workspace'), model: { primary: 'reka/deepseek4-flash' }, heartbeat: { every: '0m' } } },
  skills: { allowBundled: [] }, browser: { enabled: false }, cron: { enabled: false },
}), { REKA_API_KEY: 'offline-distribution-placeholder' });

openclaw(profile, ['plugins', 'install', archive, '--force', '--accept-capabilities']);
// Route the profile to a closed loopback port before any catalog action.
const cfg = JSON.parse(readFileSync(profile.configPath, 'utf8'));
assert.ok(!cfg.plugins?.load?.paths?.length, 'Installation unexpectedly depends on source paths');
cfg.plugins.entries ??= {};
cfg.plugins.entries.reka = { enabled: true, config: { baseUrl: 'http://127.0.0.1:1/v1' } };
writeFileSync(profile.configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
assert.equal(cliJson(openclaw(profile, ['config', 'validate', '--json'])).valid, true);
const inspection = cliJson(openclaw(profile, ['plugins', 'inspect', 'reka', '--runtime', '--json']));
assert.equal(inspection.plugin.status, 'loaded');
assert.deepEqual(inspection.plugin.providerIds, ['reka']);
assert.ok(realpathSync(inspection.plugin.rootDir).startsWith(realpathSync(profile.state) + path.sep), 'Provider did not load from the isolated installation');
const catalog = cliJson(openclaw(profile, ['models', 'list', '--all', '--provider', 'reka', '--refresh', '--json']));
assert.equal(catalog.count, snapshotIds().length);
assert.ok(catalog.models.some((m) => m.key === 'reka/deepseek4-flash'));
console.log('PASS: packed archive installs and loads without the source checkout.');
