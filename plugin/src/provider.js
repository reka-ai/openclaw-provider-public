import { createProviderApiKeyAuthMethod, isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { API_KEY_ENV, DEFAULT_MODEL, PROVIDER_ID, catalogRows, loadModels, resolveBaseUrl, resolveKnownModel, snapshotModels } from "./catalog.js";

// Env var names, including custom ones the SDK's marker list does not know.
const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * `apiKey` may be a marker such as the env var name, which the runtime resolves
 * per request and which belongs in provider config. Listing needs the real
 * secret: prefer `discoveryApiKey` and never send a marker as a token.
 */
function resolveCredentials(ctx) {
  const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
  const candidate = discoveryApiKey ?? apiKey;
  const usable = candidate && candidate !== API_KEY_ENV && !ENV_VAR_NAME.test(candidate) && !isNonSecretApiKeyMarker(candidate);
  return { apiKey, listingKey: usable ? candidate : undefined };
}

export function createRekaProvider(pluginConfig = {}) {
  // Validate before registration so a malformed override cannot silently use the live service.
  const baseUrl = resolveBaseUrl(pluginConfig);
  const wizardSetup = {
    choiceId: "reka-api-key",
    choiceLabel: "Reka API key",
    choiceHint: "Open-weight models; DeepSeek 4 Flash recommended",
    groupId: "reka",
    groupLabel: "Reka",
    methodId: "api-key",
    assistantVisibility: "visible",
    onboardingFeatured: true,
    // No fixed allowedKeys: the picker loads the catalog, so models added to
    // Reka's /v1/models appear without a plugin release.
    modelAllowlist: {
      initialSelections: [DEFAULT_MODEL],
      loadCatalog: true,
      message: "Choose Reka models to show in the model picker",
    },
    modelSelection: { promptWhenAuthChoiceProvided: true, allowKeepCurrent: true },
  };
  return {
    id: PROVIDER_ID,
    label: "Reka",
    envVars: [API_KEY_ENV],
    wizard: {
      setup: wizardSetup,
      modelPicker: { label: "Reka", hint: "DeepSeek 4 Flash recommended", methodId: "api-key" },
    },
    auth: [createProviderApiKeyAuthMethod({
      providerId: PROVIDER_ID,
      methodId: "api-key",
      label: "Reka API key",
      hint: "API key from developer.reka.ai",
      optionKey: "rekaApiKey",
      flagName: "--reka-api-key",
      envVar: API_KEY_ENV,
      promptMessage: "Enter your Reka API key",
      defaultModel: DEFAULT_MODEL,
      wizard: wizardSetup,
      noteTitle: "Reka",
      noteMessage: "Get an API key at https://developer.reka.ai. DeepSeek 4 Flash is the default for text and tools. The model list is read from your Reka account and stays current.",
    })],
    catalog: {
      order: "simple",
      async run(ctx) {
        if (ctx.providerIds && !ctx.providerIds.includes(PROVIDER_ID)) return null;
        const { apiKey, listingKey } = resolveCredentials(ctx);
        if (!apiKey) return null;
        const { models } = listingKey
          ? await loadModels({ baseUrl, apiKey: listingKey, signal: ctx.signal })
          : { models: snapshotModels() };
        return { provider: { baseUrl, api: "openai-completions", apiKey, models } };
      },
    },
    // Starter models: usable right after sign-in and used to prepare agent
    // runtimes while discovery runs. The SDK forbids network I/O here.
    staticCatalog: {
      order: "simple",
      async run() {
        return { provider: { baseUrl, api: "openai-completions", models: snapshotModels() } };
      },
    },
    // Ids missing from the prepared catalog (for example a model Reka listed
    // after this release, used with `--model reka/<id>`). Sync and offline.
    resolveDynamicModel(ctx) {
      if (ctx.provider && ctx.provider !== PROVIDER_ID) return null;
      const model = resolveKnownModel(baseUrl, ctx.modelId);
      return model ? { ...model, provider: PROVIDER_ID, api: "openai-completions", baseUrl } : null;
    },
  };
}

/** Picker rows from Reka's live /v1/models; null lets OpenClaw fall back to static rows. */
export function createRekaLiveCatalog(pluginConfig = {}) {
  const baseUrl = resolveBaseUrl(pluginConfig);
  return async (ctx) => {
    if (ctx.includeLive === false) return null;
    const { listingKey } = resolveCredentials(ctx);
    if (!listingKey) return null;
    const { source, models } = await loadModels({ baseUrl, apiKey: listingKey, timeoutMs: ctx.timeoutMs, signal: ctx.signal });
    return source === "live" ? catalogRows(models, "live") : null;
  };
}
