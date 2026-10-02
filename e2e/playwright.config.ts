import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';

const chromium = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  outputDir: './.tmp/results',
  use: {
    launchOptions: chromium ? { executablePath: chromium } : {},
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
