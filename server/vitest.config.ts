import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
          GOOGLE_CLIENT_SECRET: "test-secret",
          TWITCH_CLIENT_ID: "test-twitch-client",
          TWITCH_CLIENT_SECRET: "test-twitch-secret",
          PUBLIC_ORIGIN: "https://auth.livefeed.test",
        },
      },
    }),
  ],
});
