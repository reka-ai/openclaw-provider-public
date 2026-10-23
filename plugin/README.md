# Reka for OpenClaw

Adds Reka as a provider in OpenClaw's API-key setup and model picker, with **DeepSeek 4 Flash** recommended for text and tools. Requests use OpenClaw's OpenAI-compatible chat transport at `https://api.reka.ai/v1`.

Requires **OpenClaw 2026.10.2 or newer**, on the Node version your OpenClaw release requires (the plugin itself runs on Node 24.16+ within 24.x, or 26.1+). Tested with OpenClaw 2026.10.2 and 2026.10.6. Published on ClawHub by Reka as `openclaw-reka-provider`.

## Install and sign in

```sh
openclaw plugins install clawhub:openclaw-reka-provider
openclaw models auth login --provider reka --method api-key --set-default
openclaw config set agents.defaults.thinkingDefault off
```

OpenClaw asks you to accept the plugin's permissions. Wait for the masked **Enter your Reka API key** prompt before pasting your key; get one from [Reka's developer portal](https://developer.reka.ai). `--set-default` makes DeepSeek 4 Flash the default model. The full walkthrough, including installing from source, is in the repository's [docs/SETUP.md](https://github.com/reka-ai/openclaw-provider-public/blob/main/docs/SETUP.md).

Use the model picker, or send `/model reka/<model-id>` to switch the current chat. `openclaw models set` changes the default for new chats.

## Models

The model list comes from your Reka account. When the Gateway starts, when your key changes, and on `openclaw models list --refresh`, the plugin reads `GET /v1/models` with your key. Listing is not an inference call and is not billed, though Reka refuses it for an account with no credit. Each result is kept for about 10 minutes (1 minute after a failed read); restart the Gateway to read it again sooner.

- From the live list, only models that are ready (`is_ready` is not `false`), produce text and support tool calling are offered, since OpenClaw runs agents.
- Context window, image input, prices (USD per million tokens) and reasoning support come from the listing. A model without listed prices shows a cost of 0. Output is capped at 8,192 tokens per request; this is not a spending limit. Video input is not used.
- A snapshot of the list ships in `catalog/reka-models.json`. OpenClaw shows these starter models straight after sign-in, and the plugin uses them if Reka cannot be reached (timeout, error, or an unusable response). They stay listed until the next release, even if Reka pauses or retires one.

## Reasoning

For models that list reasoning support, OpenClaw's thinking levels map to Reka's `reasoning_effort`: `off` sends `none`, and `minimal`, `low`, `medium`, `high` and `xhigh` pass through. Models without reasoning support never receive `reasoning_effort`. Setting `agents.defaults.thinkingDefault off` keeps replies fast.

## Local endpoint override

For loopback testing only, `plugins.entries.reka.config.baseUrl` accepts an HTTP(S) URL on `127.0.0.1` or `[::1]`. Any other value must be `https://api.reka.ai/v1`. URLs with credentials, a query or a fragment are rejected. Do not use a real key with a test proxy.

See [provider plugins](https://docs.openclaw.ai/plugins/sdk-provider-plugins) and [publishing](https://docs.openclaw.ai/clawhub/publishing).
