import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  workers: 2,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4328', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'npm run dev:api', url: 'http://127.0.0.1:4329/api/health', reuseExistingServer: !process.env.CI, timeout: 30000 },
    { command: 'npm run dev:web', url: 'http://127.0.0.1:4328', reuseExistingServer: !process.env.CI, timeout: 30000 },
  ],
});
