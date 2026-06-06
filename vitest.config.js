import { defineConfig } from 'vitest/config';

// Inject dummy env so modules that load config.js at import time don't throw.
export default defineConfig({
  test: {
    env: {
      TELEGRAM_BOT_TOKEN: 'test-token',
      SUPABASE_URL: 'http://localhost',
      SUPABASE_SERVICE_KEY: 'test-key',
    },
  },
});
