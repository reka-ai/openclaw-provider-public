import { createHash } from "node:crypto";
import snapshot from "../catalog/reka-models.json" with { type: "json" };

export const PROVIDER_ID = "reka";
export const BASE_URL = "https://api.reka.ai/v1";
export const DEFAULT_MODEL_ID = "deepseek4-flash";
export const DEFAULT_MODEL = `${PROVIDER_ID}/${DEFAULT_MODEL_ID}`;
export const API_KEY_ENV = "REKA_API_KEY";
export const CATALOG_DATE = snapshot.captured_at;
export const OUTPUT_TOKEN_CEILING = 8192;
export const LIVE_TIMEOUT_MS = 5000;

const LIVE_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const perMillion = (value) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Number((number * 1_000_000).toFixed(9)) : 0;
};
const positiveInt = (value) => (Number.isInteger(value) && value > 0 ? value : undefined);
const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);

/**
 * OpenClaw is an agent host, so only ready chat models that can call tools are
 * offered. Rows follow the /v1/models contract: every listing field except
 * `id` is optional and omitted when undeclared.
 */
export function isUsableRow(row) {
  if (!row || typeof row.id !== "string" || !/^[\w.:-]+$/.test(row.id)) return false;
  if (row.is_ready === false) return false;
  const output = strings(row.output_modalities);
  if (output.length && !output.includes("text")) return false;
  return strings(row.supported_features).includes("tools");
}

/** Fresh objects avoid leaking mutations between catalog calls and agents. */
export function toModel(row) {
  const features = strings(row.supported_features);
  const input = strings(row.input_modalities).filter((kind) => kind === "text" || kind === "image");
  const reasoning = features.includes("reasoning");
  const label = typeof row.name === "string" && row.name.trim() ? row.name.trim() : row.id;
  return {
    id: row.id,
    name: row.id === DEFAULT_MODEL_ID ? `${label} (recommended)` : label,
    reasoning,
    input: input.length ? input : ["text"],
    cost: {
      input: perMillion(row.pricing?.prompt),
      output: perMillion(row.pricing?.completion),
      cacheRead: perMillion(row.pricing?.input_cache_read),
      cacheWrite: 0,
    },
    contextWindow: positiveInt(row.context_length) ?? 32768,
    maxTokens: Math.min(OUTPUT_TOKEN_CEILING, positiveInt(row.max_output_length) ?? OUTPUT_TOKEN_CEILING),
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsTools: true,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      thinkingFormat: "openai",
      // Only send reasoning_effort to models that declare reasoning support.
      supportsReasoningEffort: reasoning,
      ...(reasoning && {
        supportedReasoningEfforts: [...REASONING_EFFORTS],
        reasoningEffortMap: { off: "none", ultra: "max" },
      }),
    },
  };
}

/** Usable models with duplicates removed: the default first, then listing order. */
export function modelsFromRows(rows) {
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (isUsableRow(row) && !byId.has(row.id)) byId.set(row.id, toModel(row));
  }
  const models = [...byId.values()];
  const index = models.findIndex((model) => model.id === DEFAULT_MODEL_ID);
  if (index > 0) models.unshift(...models.splice(index, 1));
  return models;
}

export function snapshotModels() {
  return modelsFromRows(snapshot.data);
}

let cache;
const pending = new Map();

/** Test seam: forget cached and in-flight live results. */
export function resetLiveCache() {
  cache = undefined;
  pending.clear();
}

/** Reads at most MAX_RESPONSE_BYTES, stopping the download as soon as it is exceeded. */
async function readCapped(response) {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new Error("Reka /models response is too large");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new Error("Reka /models response is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads the authenticated chat list. Listing models is not an inference request
 * and is not billed. Throws on any failure so callers choose the fallback.
 */
export async function fetchLiveModels({ baseUrl, apiKey, timeoutMs = LIVE_TIMEOUT_MS, signal, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error("A Reka API key is required to list models");
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    // Never follow a redirect with the key attached.
    redirect: "error",
    // OpenClaw aborts on shutdown or config replacement.
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`Reka /models returned HTTP ${response.status}`);
  const models = modelsFromRows(JSON.parse(await readCapped(response))?.data);
  if (!models.length) throw new Error("Reka /models listed no tool-capable chat models");
  return models;
}

/**
 * Live models when the listing answers, otherwise the bundled snapshot. Results
 * are cached per endpoint and key hash so catalog refreshes stay cheap, and
 * Reka failures are cached briefly so an offline host is not slowed on every
 * call. Concurrent calls for the same key share one request.
 */
export async function loadModels({ baseUrl, apiKey, timeoutMs, signal, fetchImpl, now = Date.now() }) {
  const key = `${baseUrl}\0${createHash("sha256").update(String(apiKey)).digest("hex")}`;
  if (cache?.key === key && cache.expires > now) return { source: cache.source, models: structuredClone(cache.models) };
  let request = pending.get(key);
  if (!request) {
    request = fetchLiveModels({ baseUrl, apiKey, timeoutMs, signal, fetchImpl })
      .then(
        (models) => ({ source: "live", models }),
        (error) => ({
          source: "snapshot",
          models: snapshotModels(),
          // A host abort or the caller's own shorter budget says nothing about Reka.
          transient: Boolean(signal?.aborted) || (timeoutMs !== undefined && error?.name === "TimeoutError"),
        }),
      )
      .then((result) => {
        if (!result.transient) {
          cache = { key, source: result.source, models: result.models, expires: now + (result.source === "live" ? LIVE_TTL_MS : FAILURE_TTL_MS) };
        }
        return result;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
  }
  const result = await request;
  return { source: result.source, models: structuredClone(result.models) };
}

/** Explicit local proxy override for audited demos; keys cannot go to arbitrary hosts. */
export function resolveBaseUrl(config = {}) {
  const raw = config.baseUrl ?? BASE_URL;
  if (typeof raw !== "string") throw new Error("Reka baseUrl must be a URL string");
  let url;
  try { url = new URL(raw); } catch { throw new Error("Reka baseUrl must be an absolute URL"); }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Reka baseUrl must not contain credentials, a query, or a fragment");
  }
  const baseUrl = url.href.replace(/\/+$/, "");
  if (baseUrl === BASE_URL) return baseUrl;
  // IP literals only: a hostname such as localhost is resolved and could point elsewhere.
  const isLoopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (!isLoopback || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Reka baseUrl must be https://api.reka.ai/v1 or an explicitly configured loopback proxy");
  }
  return baseUrl;
}

export function catalogRows(models = snapshotModels(), source = "static") {
  return models.map(({ id, name }) => ({ kind: "text", provider: PROVIDER_ID, model: id, label: name, source }));
}
