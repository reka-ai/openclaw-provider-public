// Native host end to end against a loopback stand-in for api.reka.ai: the live
// /v1/models catalog, a tool call and a next-turn continuation. No Reka calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { cliJson, isolatedProfile, plugin, runtime, snapshotIds } from './harness.mjs';

const listing = {
  object: 'list',
  data: [
    { id: 'qwen3.8-27b', object: 'model', created: 1, owned_by: 'reka', input_modalities: ['text', 'image'], context_length: 262144, max_output_length: 131072, supported_features: ['tools', 'reasoning'], is_ready: true },
    { id: 'live-only-model', object: 'model', created: 2, owned_by: 'reka', supported_features: ['tools'] },
    { id: 'paused-model', object: 'model', created: 3, owned_by: 'reka', supported_features: ['tools'], is_ready: false },
  ],
};
const listingRequests = [];
const requests = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (req.method === 'GET' && req.url === '/v1/models') {
    listingRequests.push({ authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(listing));
    return;
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  const body = JSON.parse(raw);
  requests.push({ authorization: req.headers.authorization === 'Bearer offline-mock-key', body });
  const hadToolResult = body.messages.some((message) => message.role === 'tool');
  const isContinuation = body.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('REPLAY_OK'));
  const delta = hadToolResult
    ? { content: isContinuation ? 'REPLAY_OK reka/qwen3.8-27b' : 'Offline integration verified: session_status completed through the Reka provider.' }
    : { tool_calls: [{ index: 0, id: 'callofflinestatus', type: 'function', function: { name: 'tool_call', arguments: '{"id":"session_status","args":{}}' } }] };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = { id: 'offline-fixture', object: 'chat.completion.chunk', created: 1, model: 'qwen3.8-27b' };
  const stream = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: hadToolResult ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  // Fragment SSE across writes to exercise the actual client stream decoder.
  res.write(stream.slice(0, 101));
  setTimeout(() => res.end(stream.slice(101)), 10);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

const profile = isolatedProfile('agent', (state) => ({
  gateway: { mode: 'local' },
  plugins: { allow: ['reka'], load: { paths: [plugin] }, slots: { memory: 'none' }, entries: { reka: { enabled: true, config: { baseUrl } } } },
  agents: { defaults: {
    model: { primary: 'reka/qwen3.8-27b', fallbacks: [] },
    models: {
      'reka/qwen3.8-27b': { params: { maxTokens: 256, temperature: 0 } },
      'reka/live-only-model': { params: { maxTokens: 256, temperature: 0 } },
    },
    workspace: path.join(state, 'workspace'), skipBootstrap: true,
    thinkingDefault: 'off', reasoningDefault: 'off', utilityModel: '', heartbeat: { every: '0m' }, timeoutSeconds: 60,
  } },
  tools: { profile: 'minimal', allow: ['session_status'], deny: ['gateway'] },
  skills: { allowBundled: [] }, browser: { enabled: false }, cron: { enabled: false },
}), { REKA_API_KEY: 'offline-mock-key' });

/** Async spawn: the loopback server shares this event loop. */
function openclaw(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(runtime, 'openclaw'), args, { cwd: profile.state, env: profile.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`openclaw ${args[0]} exceeded 90 seconds`)); }, 90_000);
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`openclaw ${args.join(' ')} exited ${code}:\n${stderr}\n${stdout}`));
    });
  });
}
const turn = (message) => openclaw(['agent', '--local', '--agent', 'main', '--session-key', 'agent:main:offline-verification', '--message', message, '--thinking', 'off', '--json']);

try {
  const catalog = cliJson(await openclaw(['models', 'list', '--all', '--provider', 'reka', '--refresh', '--json']));
  // Starter models (bundled snapshot) plus the account's ready live models.
  const expected = [...new Set([...snapshotIds(), 'qwen3.8-27b', 'live-only-model'])].map((id) => `reka/${id}`).sort();
  assert.deepEqual(catalog.models.map((model) => model.key).sort(), expected, 'Live models must join the starter list; paused ones must not');
  assert.ok(listingRequests.length >= 1 && listingRequests.every((request) => request.authorization === 'Bearer offline-mock-key'));

  const first = await turn('Call session_status, then give a one sentence confirmation.');
  assert.equal(requests.length, 2, 'Expected exactly one tool call and one final response');
  assert.ok(requests[0].body.tools.some((tool) => tool.function?.name === 'tool_call'));
  const toolResult = requests[1].body.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'callofflinestatus');
  assert.ok(toolResult, 'Expected native tool result in follow-up messages');
  assert.doesNotMatch(toolResult.content, /not found|denied|error/i);
  assert.match(toolResult.content, /reka\/qwen3\.8-27b/);
  assert.match(first, /Offline integration verified/);
  const firstResult = JSON.parse(first);
  assert.equal(firstResult.meta.toolSummary.failures, 0);
  assert.equal(firstResult.meta.aborted, false);
  assert.equal(firstResult.meta.executionTrace.attempts[0].result, 'success');
  // A fresh user turn must replay the complete tool history.
  const second = await turn('From the previous session_status result, reply REPLAY_OK followed by the provider/model.');
  assert.equal(requests.length, 3, 'Continuation should require one additional inference request');
  assert.ok(requests[2].body.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'callofflinestatus'), 'Continuation must retain the matching previous tool result');
  assert.ok(requests[2].body.messages.some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('Offline integration verified')), 'Continuation must retain the prior final response');
  assert.match(second, /REPLAY_OK reka\/qwen3\.8-27b/);
  for (const request of requests) {
    assert.equal(request.authorization, true);
    assert.equal(request.body.model, 'qwen3.8-27b');
    assert.equal(request.body.reasoning_effort, 'none');
    assert.equal(request.body.stream, true);
    assert.ok((request.body.max_tokens ?? request.body.max_completion_tokens) <= 256);
  }

  // A model that exists only in the live listing (not in the bundled starter
  // list) is still usable by id in a new process, via resolveDynamicModel.
  const before = requests.length;
  await openclaw(['agent', '--local', '--agent', 'main', '--session-key', 'agent:main:dynamic-model', '--model', 'reka/live-only-model', '--message', 'Call session_status, then give a one sentence confirmation.', '--thinking', 'off', '--json']);
  const dynamic = requests.slice(before);
  assert.ok(dynamic.length >= 1, 'The dynamic model made at least one request');
  assert.ok(dynamic.every((request) => request.authorization && request.body.model === 'live-only-model'));
  assert.ok(dynamic.every((request) => !('reasoning_effort' in request.body)), 'live-only-model declares no reasoning support');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log(`PASS: live /v1/models catalog, native tool round-trip and continuation; ${listingRequests.length} listing and ${requests.length} chat requests, all loopback.`);
