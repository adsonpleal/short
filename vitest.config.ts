import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Only the TTL is overridden; BASE_URL is inherited from wrangler.jsonc.
          // The Cache API is a no-op under the pool, so a cache-dependent assertion
          // here would prove nothing. Disable the path outright to keep every test
          // deterministic; caching is verified on the real hostname instead.
          REDIRECT_CACHE_TTL: "0",
        },
      },
    }),
  ],
});
