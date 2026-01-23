import { defineConfig, devices, expect } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  use: {
    headless: process.env.CI === 'true',
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: 'npm run dev',
    port: 5173,
    timeout: 120 * 1000,
  },
  projects: [
    {
      name: 'Basic Workflow',
      testMatch: /basic-workflow/,
    },
    {
      name: 'Channel Management',
      testMatch: /channel-management/,
    },
    {
      name: 'Device Configuration',
      testMatch: /device-config/,
    },
    {
      name: 'Keyboard Shortcuts',
      testMatch: /keyboard-shortcuts/,
    },
  ],
  timeout: 30 * 1000,
});
