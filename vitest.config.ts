import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the web/tsconfig.json paths so backend.ts imports resolve
      '@cronagent/loader': resolve(__dirname, 'src/loader.ts'),
      '@cronagent/runner': resolve(__dirname, 'src/runner.ts'),
      '@cronagent/history': resolve(__dirname, 'src/history.ts'),
      '@cronagent/composer': resolve(__dirname, 'src/composer.ts'),
      '@cronagent/notifier': resolve(__dirname, 'src/notifier.ts'),
      '@cronagent/scheduler': resolve(__dirname, 'src/scheduler.ts'),
      '@cronagent/usage-tracker': resolve(__dirname, 'src/usage-tracker.ts'),
      '@cronagent/types': resolve(__dirname, 'src/types.ts'),
      '@cronagent/skip-list': resolve(__dirname, 'src/skip-list.ts'),
      // Mirror web/tsconfig.json @/* → web/* so Next.js route files can be
      // imported directly in tests without needing the Next.js build pipeline.
      '@': resolve(__dirname, 'web'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
