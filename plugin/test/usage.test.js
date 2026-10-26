import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRekaProvider } from "../src/provider.js";
import { CREDITS_URL, fetchRekaUsage, resetUsageCache, resolveCreditsUrl, toUsageSnapshot } from "../src/usage.js";

const KEY = "a".repeat(64);
const pass = {
  status: "current", credit_usd: 30, remaining_usd: 21.15,
  period_start: "2026-10-21T00:00:00Z", period_end: "2026-11-21T00:00:00Z", renews_at: "2026-11-21T00:00:00Z",
};
const credits = (overrides = {}) => ({
  object: "credits", available_usd: 33.55, reka_pass: pass,
  period: { start: "2026-10-01", end: "2026-11-01", spend_usd: 8.85 }, ...overrides,
});
const json = (body, init = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

/** Records calls and answers with `respond`; never touches the network. */
function stubFetch(respond = () => json(credits())) {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return respond(url, init); };
  return { calls, fetchFn };
}

test.beforeEach(() => resetUsageCache());

test("manifest declares Reka as a usage provider", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url)));
  assert.deepEqual(manifest.contracts.usageProviders, ["reka"]);
});

test("credits come from the console, or from the loopback proxy's own origin in tests", () => {
  assert.equal(resolveCreditsUrl("https://api.reka.ai/v1"), CREDITS_URL);
  assert.equal(CREDITS_URL, "https://developer.reka.ai/api/v1/credits");
  assert.equal(resolveCreditsUrl("http://127.0.0.1:4010/v1"), "http://127.0.0.1:4010/api/v1/credits");
});

test("a Reka Pass shows as a monthly window and budget beside the balance and period spend", () => {
  const resetAt = Date.parse("2026-11-21T00:00:00Z");
  assert.deepEqual(toUsageSnapshot(credits()), {
    provider: "reka",
    displayName: "Reka",
    plan: "Reka Pass",
    windows: [{ label: "Reka Pass", usedPercent: 29.5, resetAt }],
    billing: [
      { type: "balance", label: "Balance", amount: 33.55, unit: "USD" },
      { type: "budget", label: "Reka Pass credit used", used: 8.85, limit: 30, unit: "USD", period: "monthly", resetAt },
      { type: "spend", label: "Spent this billing period", amount: 8.85, unit: "USD", resetAt: Date.parse("2026-11-01") },
    ],
  });
});

test("without a Pass, the balance leads and no window is shown", () => {
  const snapshot = toUsageSnapshot(credits({ reka_pass: null, period: null }));
  assert.equal(snapshot.plan, undefined);
  assert.deepEqual(snapshot.windows, []);
  assert.deepEqual(snapshot.billing, [{ type: "balance", label: "Balance", amount: 33.55, unit: "USD" }]);
});

test("a cancelled or unpaid Pass is named as such; an un-itemised one shows no window", () => {
  assert.equal(toUsageSnapshot(credits({ reka_pass: { ...pass, status: "canceling", renews_at: null } })).plan, "Reka Pass, not renewing");
  const unpaid = toUsageSnapshot(credits({ reka_pass: { ...pass, status: "past_due", remaining_usd: null } }));
  assert.equal(unpaid.plan, "Reka Pass, payment due");
  assert.deepEqual(unpaid.windows, []);
  assert.deepEqual(unpaid.billing.map((item) => item.type), ["balance", "spend"]);
  // Without a renewal, the Pass resets when its month ends.
  const cancelled = toUsageSnapshot(credits({ reka_pass: { ...pass, renews_at: null } }));
  assert.equal(cancelled.windows[0].resetAt, Date.parse(pass.period_end));
});

test("an overspent or empty Pass reads as fully used", () => {
  assert.equal(toUsageSnapshot(credits({ reka_pass: { ...pass, remaining_usd: 0 } })).windows[0].usedPercent, 100);
  assert.equal(toUsageSnapshot(credits({ reka_pass: { ...pass, credit_usd: 0, remaining_usd: 0 } })).windows[0].usedPercent, 100);
});

test("a response that is not a credits object is reported, not guessed at", () => {
  for (const body of [null, {}, { object: "credits" }, { object: "credits", available_usd: "12" }, { object: "list", available_usd: 1 }]) {
    assert.equal(toUsageSnapshot(body).error, "Malformed usage response");
  }
});

test("reads credits with the key as a bearer token and never follows redirects", async () => {
  const { calls, fetchFn } = stubFetch();
  const snapshot = await fetchRekaUsage({ creditsUrl: CREDITS_URL, apiKey: KEY, fetchFn });
  assert.equal(snapshot.error, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CREDITS_URL);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init.redirect, "error");
});

test("HTTP and transport failures become short errors", async () => {
  const cases = [[401, "Invalid API key"], [403, "Invalid API key"], [404, "Usage unavailable"], [429, "Rate limited"], [503, "Usage unavailable"]];
  for (const [status, error] of cases) {
    const { fetchFn } = stubFetch(() => json({ error: { message: "x" } }, { status }));
    assert.equal((await fetchRekaUsage({ creditsUrl: CREDITS_URL, apiKey: KEY, fetchFn })).error, error, `HTTP ${status}`);
  }
  const offline = await fetchRekaUsage({ creditsUrl: CREDITS_URL, apiKey: KEY, fetchFn: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(offline.error, "Usage unavailable");
  const garbled = await fetchRekaUsage({ creditsUrl: CREDITS_URL, apiKey: KEY, fetchFn: async () => json("{not json") });
  assert.equal(garbled.error, "Malformed usage response");
  const huge = await fetchRekaUsage({ creditsUrl: CREDITS_URL, apiKey: KEY, fetchFn: async () => json(`"${"x".repeat(70_000)}"`) });
  assert.equal(huge.error, "Malformed usage response");
});

test("answers are reused for a minute per key; failures are not cached", async () => {
  const { calls, fetchFn } = stubFetch();
  const now = Date.parse("2026-10-26T00:00:00Z");
  await fetchRekaUsage({ creditsUrl: CREDITS_URL, apiKey: KEY, fetchFn, now });
  await fetchRekaUsage({ creditsUrl: CREDITS_URL, apiKey: KEY, fetchFn, now: now + 59_000 });
  assert.equal(calls.length, 1);
  await fetchRekaUsage({ creditsUrl: CREDITS_URL, apiKey: "b".repeat(64), fetchFn, now: now + 59_000 });
  assert.equal(calls.length, 2, "Another key reads its own account");
  await fetchRekaUsage({ creditsUrl: CREDITS_URL, apiKey: KEY, fetchFn, now: now + 61_000 });
  assert.equal(calls.length, 3);

  resetUsageCache();
  let status = 503;
  const flaky = stubFetch(() => (status === 200 ? json(credits()) : json({}, { status })));
  assert.equal((await fetchRekaUsage({ creditsUrl: CREDITS_URL, apiKey: KEY, fetchFn: flaky.fetchFn, now })).error, "Usage unavailable");
  status = 200;
  assert.equal((await fetchRekaUsage({ creditsUrl: CREDITS_URL, apiKey: KEY, fetchFn: flaky.fetchFn, now })).error, undefined);
});

test("provider hooks read usage with the resolved Reka key and OpenClaw's fetch", async () => {
  const provider = createRekaProvider({ baseUrl: "http://127.0.0.1:4010/v1" });
  const resolveCtx = (apiKey) => ({
    env: { REKA_API_KEY: KEY },
    resolveApiKeyFromConfigAndStore: ({ envDirect }) => { assert.deepEqual(envDirect, [KEY]); return apiKey; },
  });
  assert.deepEqual(await provider.resolveUsageAuth(resolveCtx(KEY)), { token: KEY });
  // A marker such as the env var name is not a secret and must not be sent.
  assert.equal(await provider.resolveUsageAuth(resolveCtx("REKA_API_KEY")), null);
  assert.equal(await provider.resolveUsageAuth(resolveCtx(undefined)), null);

  const { calls, fetchFn } = stubFetch();
  const snapshot = await provider.fetchUsageSnapshot({ token: KEY, fetchFn, timeoutMs: 5000 });
  assert.equal(snapshot.plan, "Reka Pass");
  assert.equal(calls[0].url, "http://127.0.0.1:4010/api/v1/credits");
});
