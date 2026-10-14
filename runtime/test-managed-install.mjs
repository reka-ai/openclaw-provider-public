// Installs the packed archive through OpenClaw's managed npm-pack path with npm offline.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cliJson, isolatedProfile, openclaw, packPlugin, snapshotIds } from './harness.mjs';

const archive = packPlugin();
const profile = isolatedProfile('managed', (state) => {
  writeFileSync(path.join(state, 'empty.npmrc'), '');
  return {
    gateway: { mode: 'local', bind: 'loopback' },
    plugins: { slots: { memory: 'none' } },
    agents: { defaults: { workspace: path.join(state, 'workspace'), model: { primary: 'reka/deepseek4-flash' }, heartbeat: { every: '0m' } } },
    skills: { allowBundled: [] }, browser: { enabled: false }, cron: { enabled: false },
  };
}, { REKA_API_KEY: 'offline-managed-placeholder', npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' });
profile.env.npm_config_userconfig = path.join(profile.state, 'empty.npmrc');

openclaw(profile, ['plugins', 'install', `npm-pack:${archive}`, '--force', '--accept-capabilities']);
const cfg = JSON.parse(readFileSync(profile.configPath, 'utf8'));
assert.ok(!cfg.plugins?.load?.paths?.length, 'Unexpected source-checkout dependency');
cfg.plugins.entries ??= {};
cfg.plugins.entries.reka = { enabled: true, config: { baseUrl: 'http://127.0.0.1:1/v1' } };
writeFileSync(profile.configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
assert.equal(cliJson(openclaw(profile, ['config', 'validate', '--json'])).valid, true);
const inspection = cliJson(openclaw(profile, ['plugins', 'inspect', 'reka', '--runtime', '--json']));
assert.equal(inspection.plugin.status, 'loaded');
assert.deepEqual(inspection.plugin.providerIds, ['reka']);
const installedRoot = realpathSync(inspection.plugin.rootDir);
assert.ok(installedRoot.startsWith(realpathSync(profile.state) + path.sep), 'Provider escaped isolated state');
assert.match(installedRoot, /[/\\]npm[/\\]projects[/\\]/, 'Provider did not use a managed npm project');
const installedPackage = JSON.parse(readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
assert.equal(installedPackage.name, '@reka/openclaw-provider');
const catalog = cliJson(openclaw(profile, ['models', 'list', '--all', '--provider', 'reka', '--refresh', '--json']));
assert.equal(catalog.count, snapshotIds().length);
assert.ok(catalog.models.some((model) => model.key === 'reka/deepseek4-flash'));
openclaw(profile, ['models', 'set', 'reka/deepseek4-flash']);
const status = cliJson(openclaw(profile, ['models', 'status', '--json']));
assert.equal(status.defaultModel, 'reka/deepseek4-flash');
assert.equal(status.resolvedDefault, 'reka/deepseek4-flash');
console.log('PASS: managed npm-pack installation loads, lists models and selects Flash.');
