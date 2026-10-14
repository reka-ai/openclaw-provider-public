import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { catalogRows } from "./src/catalog.js";
import { createRekaLiveCatalog, createRekaProvider } from "./src/provider.js";

export default definePluginEntry({
  id: "reka",
  name: "Reka",
  description: manifest.description,
  configSchema: () => buildJsonPluginConfigSchema(manifest.configSchema, {
    cacheKey: "reka-provider-config", uiHints: manifest.uiHints,
  }),
  register(api) {
    api.registerProvider(createRekaProvider(api.pluginConfig));
    api.registerModelCatalogProvider({
      provider: "reka",
      kinds: ["text"],
      // Bundled snapshot rows need no network or credentials.
      staticCatalog: () => catalogRows(),
      // Listing /v1/models with the user's key is free; it is not an inference call.
      liveCatalog: createRekaLiveCatalog(api.pluginConfig),
    });
  },
});
