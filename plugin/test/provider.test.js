import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import plugin from "../index.js";
import { createRekaLiveCatalog, createRekaProvider } from "../src/provider.js";
import {
  BASE_URL, DEFAULT_MODEL, DEFAULT_MODEL_ID, catalogRows, fetchLiveModels, isUsableRow, loadModels,
  modelsFromRows, resetLiveCache, resolveBaseUrl, snapshotModels,
} from "../src/catalog.js";

const fixture = readFileSync(new URL("./fixtures/v1-models.json", import.meta.url), "utf8");
const snapshot = JSON.parse(readFileSync(new URL("../catalog/reka-models.json", import.meta.url), "utf8"));
const auth = (apiKey) => ({ resolveProviderApiKey: (id) => { assert.equal(id, "reka"); return { apiKey }; } });
const liveIds = ["deepseek4-flash", "qwen3.8-27b", "brand-new-model"];

/** Loopback stand-in for GET /v1/models; never contacts Reka. */
async function modelsEndpoint(t, respond = (res) => res.writeHead(200, { "content-type": "application/json" }).end(fixture)) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    respond(res, req);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test.beforeEach(() => resetLiveCache());

test("SDK entry registers the provider, static snapshot rows and a live catalog hook", () => {
  const providers = [];
  const catalogs = [];
  plugin.register({ registerProvider: (p) => providers.push(p), registerModelCatalogProvider: (c) => catalogs.push(c) });
  assert.equal(plugin.id, "reka");
  assert.equal(providers.length, 1);
  assert.equal(providers[0].label, "Reka");
  assert.deepEqual(catalogs[0].staticCatalog(), catalogRows());
  assert.ok(catalogs[0].staticCatalog().every((r) => r.source === "static"));
  assert.equal(typeof catalogs[0].liveCatalog, "function");
});

test("manifest, visible onboarding, auth method and recommended model agree", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url)));
  const provider = createRekaProvider();
  assert.equal(manifest.id, provider.id);
  assert.deepEqual(manifest.setup.providers[0].envVars, provider.envVars);
  assert.equal(manifest.providerAuthChoices[0].method, provider.auth[0].id);
  assert.equal(provider.auth[0].kind, "api_key");
  assert.equal(provider.auth[0].starterModel, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, "reka/deepseek4-flash");
  assert.equal(provider.wizard.setup.assistantVisibility, "visible");
  assert.equal(provider.wizard.setup.onboardingFeatured, true);
  assert.equal(provider.wizard.modelPicker.label, "Reka");
  assert.deepEqual(provider.wizard.setup.modelAllowlist.initialSelections, [DEFAULT_MODEL]);
  // A fixed allowlist would hide models added to /v1/models after release.
  assert.equal(provider.wizard.setup.modelAllowlist.allowedKeys, undefined);
  assert.equal(provider.wizard.setup.modelAllowlist.loadCatalog, true);
});

test("package compatibility is a floor, so OpenClaw upgrades keep the plugin", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.match(pkg.openclaw.compat.pluginApi, /^>=\d{4}\.\d+\.\d+$/);
  assert.match(pkg.openclaw.compat.minGatewayVersion, /^\d{4}\.\d+\.\d+$/);
  assert.match(pkg.peerDependencies.openclaw, /^>=\d{4}\.\d+\.\d+$/);
});

// Structural only: the weekly refresh must not fail on ordinary price or model changes.
test("bundled snapshot keeps every usable row, default first", () => {
  const models = snapshotModels();
  assert.ok(models.length > 0);
  assert.equal(models.length, new Set(snapshot.data.filter(isUsableRow).map((row) => row.id)).size);
  if (models.some((m) => m.id === DEFAULT_MODEL_ID)) {
    assert.equal(models[0].id, DEFAULT_MODEL_ID);
    assert.match(models[0].name, /recommended/);
  }
  assert.ok(models.every((m) => m.maxTokens <= 8192 && m.contextWindow > 0 && m.compat.supportsTools));
  assert.ok(models.every((m) => m.input.length && m.input.every((kind) => kind === "text" || kind === "image")));
  assert.deepEqual(snapshot.data.map((row) => row.id), [...snapshot.data.map((row) => row.id)].sort(), "Snapshot rows stay sorted by id");
  const before = JSON.stringify(snapshotModels()[0]);
  models[0].input.push("mutation");
  assert.equal(JSON.stringify(snapshotModels()[0]), before, "Each call returns fresh objects");
});

test("/v1/models rows map with contract defaults and only usable models", () => {
  const models = modelsFromRows(JSON.parse(fixture).data);
  assert.deepEqual(models.map((m) => m.id), liveIds);
  assert.equal(models[0].name, "DeepSeek 4 Flash (recommended)");
  assert.equal(models[0].contextWindow, 1048576);
  assert.equal(models[0].maxTokens, 8192);
  assert.deepEqual(models[0].cost, { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(models[1].input, ["text", "image"]);
  // Every listing field but id is optional; missing ones get safe defaults.
  const bare = models[2];
  assert.equal(bare.name, "brand-new-model");
  assert.deepEqual(bare.input, ["text"]);
  assert.deepEqual(bare.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(bare.contextWindow, 32768);
  assert.equal(bare.maxTokens, 8192);
  // Effort settings follow the model's declared reasoning support.
  assert.equal(bare.reasoning, false);
  assert.equal(bare.compat.supportsReasoningEffort, false);
  assert.equal(bare.compat.reasoningEffortMap, undefined);
  assert.deepEqual(models[1].compat.supportedReasoningEfforts, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(models[1].compat.reasoningEffortMap, { off: "none", ultra: "max" });
  assert.deepEqual(modelsFromRows(undefined), []);
  assert.deepEqual(modelsFromRows([{ id: "bad id/../x", supported_features: ["tools"] }, null, 42]), []);
});

test("catalog reads /v1/models with the user's key", async (t) => {
  const endpoint = await modelsEndpoint(t);
  const provider = createRekaProvider({ baseUrl: endpoint.baseUrl });
  assert.equal(await provider.catalog.run({ resolveProviderApiKey: () => ({}) }), null);
  assert.equal(await provider.catalog.run({ ...auth("test-placeholder"), providerIds: ["openai"] }), null);
  assert.equal(endpoint.requests.length, 0, "No listing request without a key or for other providers");
  const result = await provider.catalog.run({ ...auth("test-placeholder"), providerIds: ["reka"] });
  assert.equal(result.provider.baseUrl, endpoint.baseUrl);
  assert.equal(result.provider.api, "openai-completions");
  assert.equal(result.provider.apiKey, "test-placeholder");
  assert.deepEqual(result.provider.models.map((m) => m.id), liveIds);
  assert.deepEqual(endpoint.requests, [{ method: "GET", path: "/v1/models", authorization: "Bearer test-placeholder" }]);
  await provider.catalog.run(auth("test-placeholder"));
  assert.equal(endpoint.requests.length, 1, "Live results are cached");
  await provider.catalog.run(auth("other-placeholder"));
  assert.equal(endpoint.requests.length, 2, "Cache is per key");
  // Starter models stay offline and never carry a credential.
  const starter = await provider.staticCatalog.run();
  assert.equal(starter.provider.apiKey, undefined);
  assert.deepEqual(starter.provider.models, snapshotModels());
  assert.equal(endpoint.requests.length, 2);
});

test("listing uses the discovery key and never sends a secret marker", async (t) => {
  const endpoint = await modelsEndpoint(t);
  const provider = createRekaProvider({ baseUrl: endpoint.baseUrl });
  const marker = { resolveProviderApiKey: () => ({ apiKey: "REKA_API_KEY", discoveryApiKey: "discovery-placeholder" }) };
  const result = await provider.catalog.run(marker);
  // Config keeps the marker so the secret is resolved per request, not persisted.
  assert.equal(result.provider.apiKey, "REKA_API_KEY");
  assert.deepEqual(result.provider.models.map((m) => m.id), liveIds);
  assert.equal(endpoint.requests[0].authorization, "Bearer discovery-placeholder");
  resetLiveCache();
  const markerOnly = { resolveProviderApiKey: () => ({ apiKey: "REKA_API_KEY" }) };
  const fallback = await provider.catalog.run(markerOnly);
  assert.equal(fallback.provider.apiKey, "REKA_API_KEY");
  assert.deepEqual(fallback.provider.models, snapshotModels());
  assert.equal(await createRekaLiveCatalog({ baseUrl: endpoint.baseUrl })(markerOnly), null);
  // A custom env var name from an auth profile is not a secret either.
  const customName = { resolveProviderApiKey: () => ({ apiKey: "MY_REKA_KEY" }) };
  assert.deepEqual((await provider.catalog.run(customName)).provider.models, snapshotModels());
  assert.equal(endpoint.requests.length, 1, "A marker is never sent as a token");
});

test("catalog falls back to the snapshot when the listing fails", async (t) => {
  for (const respond of [
    (res) => res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"bad key"}}'),
    (res) => res.writeHead(200, { "content-type": "application/json" }).end("not json"),
    (res) => res.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"no-tools"}]}'),
  ]) {
    resetLiveCache();
    const endpoint = await modelsEndpoint(t, respond);
    const result = await loadModels({ baseUrl: endpoint.baseUrl, apiKey: "test-placeholder" });
    assert.equal(result.source, "snapshot");
    assert.deepEqual(result.models, snapshotModels());
    assert.equal(endpoint.requests.length, 1);
  }
});

test("redirects are never followed, so the key cannot be forwarded", async (t) => {
  const target = await modelsEndpoint(t);
  const origin = await modelsEndpoint(t, (res) => res.writeHead(302, { location: `${target.baseUrl}/models` }).end());
  const result = await loadModels({ baseUrl: origin.baseUrl, apiKey: "test-placeholder" });
  assert.equal(result.source, "snapshot");
  assert.equal(origin.requests.length, 1);
  assert.equal(target.requests.length, 0, "The redirect target never receives the request");
});

test("oversized listings are cut off and fall back", async (t) => {
  const endpoint = await modelsEndpoint(t, (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const chunk = Buffer.alloc(256 * 1024, " ");
    for (let i = 0; i < 12; i++) res.write(chunk);
    res.end(fixture);
  });
  const result = await loadModels({ baseUrl: endpoint.baseUrl, apiKey: "test-placeholder" });
  assert.equal(result.source, "snapshot");
});

test("Reka failures are cached briefly; host aborts and caller timeouts are not", async (t) => {
  let status = 500;
  const endpoint = await modelsEndpoint(t, (res) => {
    if (status === 0) return; // never answer
    res.writeHead(status, { "content-type": "application/json" }).end(status === 200 ? fixture : "{}");
  });
  const args = { baseUrl: endpoint.baseUrl, apiKey: "test-placeholder" };
  assert.equal((await loadModels(args)).source, "snapshot");
  status = 200;
  assert.equal((await loadModels(args)).source, "snapshot", "A Reka failure is remembered for a minute");
  assert.equal(endpoint.requests.length, 1);
  assert.equal((await loadModels({ ...args, now: Date.now() + 61_000 })).source, "live", "and retried after it");
  assert.equal(endpoint.requests.length, 2);

  resetLiveCache();
  status = 0;
  const started = Date.now();
  assert.equal((await loadModels({ ...args, timeoutMs: 100 })).source, "snapshot");
  assert.ok(Date.now() - started < 3000, "A caller's timeout falls back quickly");
  assert.equal((await loadModels({ ...args, signal: AbortSignal.abort() })).source, "snapshot");
  status = 200;
  assert.equal((await loadModels(args)).source, "live", "Neither the caller timeout nor the abort was cached");
});

test("concurrent catalog calls share one listing request", async (t) => {
  const endpoint = await modelsEndpoint(t, (res) => setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(fixture), 50));
  const args = { baseUrl: endpoint.baseUrl, apiKey: "test-placeholder" };
  const results = await Promise.all([loadModels(args), loadModels(args), loadModels(args)]);
  assert.ok(results.every((result) => result.source === "live"));
  assert.equal(endpoint.requests.length, 1);
  results[0].models[0].input.push("mutation");
  assert.deepEqual(results[1].models[0].input, ["text"], "Each caller gets its own copy");
});

test("live picker rows are labelled live and defer to static rows on failure", async (t) => {
  const endpoint = await modelsEndpoint(t);
  const live = createRekaLiveCatalog({ baseUrl: endpoint.baseUrl });
  const rows = await live(auth("test-placeholder"));
  assert.deepEqual(rows.map((r) => r.model), liveIds);
  assert.ok(rows.every((r) => r.source === "live" && r.provider === "reka" && r.kind === "text"));
  assert.equal(await live({ resolveProviderApiKey: () => ({}) }), null);
  assert.equal(await live({ ...auth("test-placeholder"), includeLive: false }), null);
  resetLiveCache();
  assert.equal(await createRekaLiveCatalog({ baseUrl: "http://127.0.0.1:1/v1" })(auth("test-placeholder")), null);
});

test("fetchLiveModels refuses to list without a key", async () => {
  await assert.rejects(fetchLiveModels({ baseUrl: BASE_URL, apiKey: "" }), /API key is required/);
});

test("only explicit loopback proxy overrides are accepted", async () => {
  assert.equal(resolveBaseUrl(), BASE_URL);
  for (const baseUrl of [`${BASE_URL}/`, "https://API.REKA.AI/v1", "https://api.reka.ai:443/v1"]) {
    assert.equal(resolveBaseUrl({ baseUrl }), BASE_URL);
  }
  for (const baseUrl of ["http://127.0.0.1:9191/v1", "http://[::1]:9191/v1"]) {
    assert.equal(resolveBaseUrl({ baseUrl }), baseUrl);
    assert.doesNotThrow(() => createRekaProvider({ baseUrl }));
  }
  for (const baseUrl of [
    "https://evil.example/v1", "http://api.reka.ai/v1", "https://api.reka.ai/v2", "https://api.reka.ai.evil/v1",
    "https://api.reka.ai./v1", "https://api.reka.ai/v1/../", "http://localhost:9191/v1", "http://localhost.evil.com/v1",
    "http://127.0.0.1.nip.io/v1", "http://[::ffff:127.0.0.1]/v1", "http://user:pass@127.0.0.1/v1",
    "http://127.0.0.1/v1?key=x", "http://127.0.0.1/v1#x", "file:///tmp/test", "not a url", 42,
  ]) {
    assert.throws(() => createRekaProvider({ baseUrl }), /Reka baseUrl/, String(baseUrl));
    assert.throws(() => createRekaLiveCatalog({ baseUrl }), /Reka baseUrl/, String(baseUrl));
  }
});

test("runtime config schema rejects unrecognized or malformed options", () => {
  assert.equal(plugin.configSchema.safeParse({}).success, true);
  assert.equal(plugin.configSchema.safeParse({ baseUrl: "http://127.0.0.1:9191/v1" }).success, true);
  assert.equal(plugin.configSchema.safeParse({ apiKey: "never-store-key-here" }).success, false);
  assert.equal(plugin.configSchema.safeParse({ baseUrl: 1 }).success, false);
});

test("SDK noninteractive auth resolution uses Reka-specific option and env name", async () => {
  const method = createRekaProvider().auth[0];
  let supplied;
  assert.equal(await method.validateNonInteractive({ opts: {}, resolveApiKey: async (args) => {
    supplied = args; return null;
  } }), false);
  assert.equal(supplied.provider, "reka");
  assert.equal(supplied.envVar, "REKA_API_KEY");
  assert.equal(supplied.flagName, "--reka-api-key");
});
