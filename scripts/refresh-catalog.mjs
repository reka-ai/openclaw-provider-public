#!/usr/bin/env node
// Refreshes the bundled starter snapshot from Reka's authenticated /v1/models.
// Reads REKA_API_KEY from the environment only; the key is never printed or
// written. Listing models is not an inference call. Exits non-zero without
// touching the snapshot when the listing fails or has no usable models.
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { BASE_URL, isUsableRow, resolveBaseUrl } from "../plugin/src/catalog.js";

const SNAPSHOT = new URL("../plugin/catalog/reka-models.json", import.meta.url);
// Fields the plugin maps; everything else (descriptions, capacity) stays out.
const FIELDS = ["id", "name", "input_modalities", "output_modalities", "context_length", "max_output_length", "pricing", "supported_features", "is_ready"];

const apiKey = process.env.REKA_API_KEY;
if (!apiKey) {
  console.error("Set REKA_API_KEY to list models.");
  process.exit(1);
}
// Loopback override for local testing only; the same check as the plugin's.
let baseUrl;
try {
  baseUrl = resolveBaseUrl({ baseUrl: process.env.REKA_CATALOG_BASE_URL || BASE_URL });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const response = await fetch(`${baseUrl}/models`, {
  headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  console.error(`GET ${baseUrl}/models returned HTTP ${response.status}; snapshot unchanged.`);
  process.exit(1);
}
const listing = await response.json();
const rows = new Map();
for (const row of Array.isArray(listing?.data) ? listing.data : []) {
  // First row wins, matching how the plugin reads the live listing.
  if (isUsableRow(row) && !rows.has(row.id)) {
    rows.set(row.id, Object.fromEntries(FIELDS.filter((field) => row[field] !== undefined).map((field) => [field, row[field]])));
  }
}
const data = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
if (!data.length) {
  console.error("The listing had no ready, tool-capable chat models; snapshot unchanged.");
  process.exit(1);
}

const current = JSON.parse(await readFile(SNAPSHOT, "utf8"));
if (isDeepStrictEqual(current.data, data)) {
  console.log(`Snapshot already current (${data.length} models).`);
  process.exit(0);
}
const before = new Set(current.data.map((row) => row.id));
const after = new Set(data.map((row) => row.id));
const snapshot = {
  source: `${BASE_URL}/models`,
  captured_at: new Date().toISOString().slice(0, 10),
  kind: "authenticated_live_catalog",
  data,
};
await writeFile(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Snapshot updated: ${data.length} models.`);
console.log(`Added: ${[...after].filter((id) => !before.has(id)).join(", ") || "none"}`);
console.log(`Removed: ${[...before].filter((id) => !after.has(id)).join(", ") || "none"}`);
