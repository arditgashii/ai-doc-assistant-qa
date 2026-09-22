import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
// Point BASE_URL at a real environment to run the same suite against staging.
const useMock = !process.env.BASE_URL;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0, // AI bugs hide behind retries. A flaky test is a finding, not noise.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/junit.xml' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    extraHTTPHeaders: { 'x-test-run': process.env.GITHUB_RUN_ID || 'local' },
  },
  projects: [
    { name: 'api', testMatch: /tests\/(api|security)\/.*\.spec\.ts/ },
    { name: 'ai-eval', testMatch: /tests\/ai\/.*\.spec\.ts/ },
    { name: 'reliability', testMatch: /tests\/reliability\/.*\.spec\.ts/ },
    { name: 'e2e', testMatch: /tests\/e2e\/.*\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: useMock
    ? {
        command: 'node mock-server/server.js',
        url: `${BASE_URL}/health`,
        reuseExistingServer: !process.env.CI,
        env: { PORT: String(PORT), MOCK_BUGS: process.env.MOCK_BUGS || '' },
      }
    : undefined,
});
