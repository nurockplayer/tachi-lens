import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/twitch-canary.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  projects: [
    {
      name: 'chromium',
      use: {
        channel: 'chromium',
        trace: {
          mode: 'retain-on-failure' as const,
          screenshots: false,
          snapshots: false,
          sources: true,
        },
      },
    },
  ],
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],
})
