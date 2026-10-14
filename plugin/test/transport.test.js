import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createLlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { readFileSync } from "node:fs";
import { modelsFromRows } from "../src/catalog.js";

const runtime = createLlmRuntime();
registerBuiltInApiProviders(runtime.registry);

async function localEndpoint(t, respond) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    requests.push({ path: req.url, authorization: req.headers.authorization, body });
    respond(res, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

function sse(res, deltas, finish = "stop") {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const delta of deltas) res.write(`data: ${JSON.stringify({ id: "local-test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

// From the fixture, not the snapshot, so catalog refreshes cannot break transport tests.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/v1-models.json", import.meta.url), "utf8"));
const qwen = modelsFromRows(fixture.data).find((m) => m.id === "qwen3.8-27b");
function model(baseUrl, definition = qwen) { return { ...definition, provider: "reka", api: "openai-completions", baseUrl }; }
const user = (content = "Say hello") => ({ role: "user", content, timestamp: 1 });

test("real OpenClaw transport sends auth, images and explicit off as none, then parses SSE usage", async (t) => {
  const endpoint = await localEndpoint(t, (res) => sse(res, [{ role: "assistant", content: "Reka " }, { content: "works" }]));
  const stream = runtime.streamSimple(model(endpoint.baseUrl), {
    systemPrompt: "Be concise",
    messages: [user([{ type: "text", text: "Describe" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }])],
  }, { apiKey: "local-test-key", reasoning: "off", maxTokens: 80 });
  const events = [];
  for await (const event of stream) events.push(event.type);
  const reply = await stream.result();
  assert.equal(reply.stopReason, "stop");
  assert.equal(reply.content[0].text, "Reka works");
  assert.equal(reply.usage.input, 12);
  assert.equal(reply.usage.output, 4);
  assert.ok(events.includes("text_delta") && events.includes("done"));
  const req = endpoint.requests[0];
  assert.equal(req.path, "/v1/chat/completions");
  assert.equal(req.authorization, "Bearer local-test-key");
  assert.equal(req.body.reasoning_effort, "none");
  assert.equal(req.body.max_tokens, 80);
  assert.equal(req.body.model, "qwen3.8-27b");
  assert.equal(req.body.stream, true);
  assert.equal(req.body.messages[0].role, "system");
  assert.equal(req.body.messages[1].content[1].type, "image_url");
});

test("transport roundtrips fragmented tool arguments, tool result and follow-up answer", async (t) => {
  const endpoint = await localEndpoint(t, (res, body) => {
    if (body.messages.some((m) => m.role === "tool")) return sse(res, [{ content: "21" }]);
    sse(res, [{ role: "assistant", tool_calls: [{ index: 0, id: "call_local_1", type: "function", function: { name: "multiply", arguments: '{"a":' } }] }, { tool_calls: [{ index: 0, function: { arguments: '3,"b":7}' } }] }], "tool_calls");
  });
  const tools = [{ name: "multiply", description: "Multiply two numbers", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }];
  const context = { messages: [user("Multiply 3 and 7 using the tool")], tools };
  const first = await runtime.completeSimple(model(endpoint.baseUrl), context, { apiKey: "local-test-key", reasoning: "low", maxTokens: 80 });
  assert.equal(first.stopReason, "toolUse");
  const call = first.content.find((c) => c.type === "toolCall");
  assert.equal(call.name, "multiply");
  assert.deepEqual(call.arguments, { a: 3, b: 7 });
  assert.equal(endpoint.requests[0].body.reasoning_effort, "low");
  assert.equal(endpoint.requests[0].body.tools[0].function.name, "multiply");
  const second = await runtime.completeSimple(model(endpoint.baseUrl), { ...context, messages: [...context.messages, first, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "21" }], isError: false, timestamp: 2 }] }, { apiKey: "local-test-key", maxTokens: 80 });
  assert.equal(second.content[0].text, "21");
  assert.ok(endpoint.requests[1].body.messages.some((m) => m.role === "tool" && m.content === "21"));
  // An unset effort is sent explicitly as none, not left to the API default.
  assert.equal(endpoint.requests[1].body.reasoning_effort, "none");
});

test("models listed without reasoning support are never sent reasoning_effort", async (t) => {
  const endpoint = await localEndpoint(t, (res) => sse(res, [{ content: "ok" }]));
  const [plain] = modelsFromRows([{ id: "plain-tools-model", supported_features: ["tools"] }]);
  for (const reasoning of ["off", "high", undefined]) {
    await runtime.completeSimple(model(endpoint.baseUrl, plain), { messages: [user()] }, { apiKey: "local-test-key", reasoning, maxTokens: 16 });
  }
  assert.equal(endpoint.requests.length, 3);
  assert.ok(endpoint.requests.every((req) => req.body.model === "plain-tools-model" && !("reasoning_effort" in req.body)));
});

test("named effort levels reach the wire unchanged", async (t) => {
  const endpoint = await localEndpoint(t, (res) => sse(res, [{ content: "ok" }]));
  for (const effort of ["minimal", "low", "medium", "high", "xhigh"]) {
    await runtime.completeSimple(model(endpoint.baseUrl), { messages: [user()] }, { apiKey: "local-test-key", reasoning: effort, maxTokens: 16 });
  }
  assert.deepEqual(endpoint.requests.map((req) => req.body.reasoning_effort), ["minimal", "low", "medium", "high", "xhigh"]);
});

test("auth failures surface as errors without successful assistant text", async (t) => {
  const endpoint = await localEndpoint(t, (res) => { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Invalid test key", type: "authentication_error" } })); });
  const reply = await runtime.completeSimple(model(endpoint.baseUrl), { messages: [user()] }, { apiKey: "invalid-local-key", maxTokens: 16 });
  assert.equal(reply.stopReason, "error");
  assert.match(reply.errorMessage, /401|Invalid test key/);
  assert.equal(endpoint.requests.length, 1);
});
