// Loads the plugin from source in the pinned host. The endpoint is a closed
// loopback port, so the live /v1/models read fails and the snapshot is used.
import assert from 'node:assert/strict';
import { cliJson, hostVersion, isolatedProfile, openclaw, plugin, snapshotIds } from './harness.mjs';

const profile = isolatedProfile('host', () => ({
  gateway: { mode: 'local', bind: 'loopback' },
  plugins: {
    allow: ['reka'],
    load: { paths: [plugin] },
    slots: { memory: 'none' },
    entries: { reka: { enabled: true, config: { baseUrl: 'http://127.0.0.1:1/v1' } } },
  },
  agents: { defaults: { model: { primary: 'reka/deepseek4-flash' } } },
}), { REKA_API_KEY: 'offline-test-key-not-a-secret' });

assert.ok(openclaw(profile, ['--version']).includes(hostVersion), `Wrapper did not run OpenClaw ${hostVersion}`);
cliJson(openclaw(profile, ['config', 'validate', '--json']));
const inspection = cliJson(openclaw(profile, ['plugins', 'inspect', 'reka', '--runtime', '--json']));
assert.equal(inspection.plugin.status, 'loaded');
assert.deepEqual(inspection.plugin.providerIds, ['reka']);
const catalog = cliJson(openclaw(profile, ['models', 'list', '--all', '--provider', 'reka', '--refresh', '--json']));
const keys = catalog.models.map((model) => model.key).sort();
assert.deepEqual(keys, snapshotIds().map((id) => `reka/${id}`).sort(), 'Unreachable listing falls back to the snapshot');
console.log(`PASS: source plugin loads in OpenClaw ${hostVersion}; ${keys.length} snapshot models offered while /v1/models is unreachable.`);
