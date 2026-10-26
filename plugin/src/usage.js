import { createHash } from "node:crypto";
import { BASE_URL, PROVIDER_ID } from "./catalog.js";

// The console serves an account's credits to the account's own API key.
// Reading them is free and never touches inference.
export const CREDITS_URL = "https://developer.reka.ai/api/v1/credits";
const DISPLAY_NAME = "Reka";
const MAX_RESPONSE_BYTES = 64 * 1024;
// The endpoint's answers can be a minute old; asking more often gains nothing.
const CACHE_TTL_MS = 60_000;

let cache;

/** Test seam: forget the cached snapshot. */
export function resetUsageCache() {
  cache = undefined;
}

/** The credits URL for an endpoint; a loopback test proxy serves it on its own origin. */
export function resolveCreditsUrl(baseUrl) {
  return baseUrl === BASE_URL ? CREDITS_URL : `${new URL(baseUrl).origin}/api/v1/credits`;
}

const round = (value) => Math.round(value * 100) / 100;
const usd = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
const timestamp = (value) => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};
const withReset = (resetAt) => (resetAt === undefined ? {} : { resetAt });
const PLAN_LABELS = { canceling: "Reka Pass, not renewing", past_due: "Reka Pass, payment due" };

function errorSnapshot(error) {
  return { provider: PROVIDER_ID, displayName: DISPLAY_NAME, windows: [], error };
}

/**
 * Maps the credits response to OpenClaw's usage snapshot. A Reka Pass becomes a
 * window (shown as "% left" in status lines) and a monthly budget; the whole
 * balance, Pass credit included, and this billing period's spend follow.
 */
export function toUsageSnapshot(body) {
  const available = usd(body?.available_usd);
  if (body?.object !== "credits" || available === undefined) return errorSnapshot("Malformed usage response");
  const windows = [];
  const billing = [{ type: "balance", label: "Balance", amount: available, unit: "USD" }];
  let plan;
  const pass = body.reka_pass;
  if (pass && typeof pass === "object") {
    plan = PLAN_LABELS[pass.status] ?? "Reka Pass";
    const limit = usd(pass.credit_usd);
    const remaining = usd(pass.remaining_usd);
    if (limit !== undefined && remaining !== undefined) {
      const used = round(Math.max(0, limit - remaining));
      const resetAt = timestamp(pass.renews_at) ?? timestamp(pass.period_end);
      windows.push({ label: "Reka Pass", usedPercent: limit === 0 ? 100 : Math.min(100, round((used / limit) * 100)), ...withReset(resetAt) });
      billing.push({ type: "budget", label: "Reka Pass credit used", used, limit, unit: "USD", period: "monthly", ...withReset(resetAt) });
    }
  }
  const spend = usd(body.period?.spend_usd);
  if (spend !== undefined) {
    billing.push({ type: "spend", label: "Spent this billing period", amount: spend, unit: "USD", ...withReset(timestamp(body.period.end)) });
  }
  return { provider: PROVIDER_ID, displayName: DISPLAY_NAME, windows, billing, ...(plan ? { plan } : {}) };
}

function httpError(status) {
  if (status === 401 || status === 403) return "Invalid API key";
  if (status === 429) return "Rate limited";
  return "Usage unavailable";
}

async function readCapped(response) {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new Error("too large");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new Error("too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads the key's credits. Never throws: OpenClaw shows the error string in
 * place of usage. Successful answers are cached per URL and key hash.
 */
export async function fetchRekaUsage({ creditsUrl, apiKey, fetchFn = globalThis.fetch, signal, now = Date.now() }) {
  const key = `${creditsUrl}\0${createHash("sha256").update(String(apiKey)).digest("hex")}`;
  if (cache?.key === key && cache.expires > now) return structuredClone(cache.snapshot);
  let response;
  try {
    response = await fetchFn(creditsUrl, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      // Never follow a redirect with the key attached.
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
  } catch {
    return errorSnapshot("Usage unavailable");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return errorSnapshot(httpError(response.status));
  }
  let body;
  try {
    body = JSON.parse(await readCapped(response));
  } catch {
    return errorSnapshot("Malformed usage response");
  }
  const snapshot = toUsageSnapshot(body);
  if (!snapshot.error) cache = { key, snapshot: structuredClone(snapshot), expires: now + CACHE_TTL_MS };
  return snapshot;
}
