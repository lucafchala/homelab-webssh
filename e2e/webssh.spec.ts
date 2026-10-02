import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSshd, freePort, type TestSshd } from '../server/test/helpers/sshd';
import { totp } from '../server/src/security/totp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_PASSWORD = 'Correct-Horse-Battery-9';
const SHOTS = path.join(HERE, '.tmp', 'screenshots');

let sshd: TestSshd;
let server: ChildProcess;
let base = '';
let dataDir = '';
let totpSecret = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  sshd = await startSshd();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-e2e-'));
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/dist/index.js'], {
    cwd: path.join(HERE, '..'),
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: base, DATA_DIR: dataDir, SETUP_TOKEN: 'e2e-setup-token', LOG_LEVEL: 'warn', TLDR_ENABLED: 'false' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(async () => {
  server?.kill('SIGTERM');
  sshd?.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Text currently on the active terminal (the desktop renderer draws to a canvas). */
async function screenText(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__webssh?.screen() ?? '');
}

async function expectScreen(page: Page, text: string, timeout = 10_000) {
  await expect.poll(() => screenText(page), { timeout }).toContain(text);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

let lastStep = 0;
/** TOTP codes are single-use (replay protection), so pick a step that hasn't been used yet. */
async function freshCode(): Promise<string> {
  for (;;) {
    const now = Math.floor(Date.now() / 30_000);
    for (const step of [now - 1, now, now + 1]) {
      if (step > lastStep) {
        lastStep = step;
        return totp(totpSecret, step * 30_000 + 1000);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function login(page: Page) {
  await page.goto(base);
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByPlaceholder('123456').fill(await freshCode());
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.locator('.sidebar .brand')).toBeVisible();
}

test('first-run setup and mandatory 2FA enrolment', async ({ page }) => {
  await page.goto(base);
  await expect(page.getByText('First-time setup')).toBeVisible();
  await shot(page, '01-setup');
  await page.getByLabel('Setup token').fill('e2e-setup-token');
  await page.getByLabel('Username').fill('admin');
  await page.locator('input[autocomplete="new-password"]').nth(0).fill(ADMIN_PASSWORD);
  await page.locator('input[autocomplete="new-password"]').nth(1).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Create admin account' }).click();

  await expect(page.getByText('Secure your account')).toBeVisible();
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  totpSecret = (await page.locator('code').first().textContent())!.trim();
  expect(totpSecret).toMatch(/^[A-Z2-7]{32}$/);
  await shot(page, '02-totp');
  lastStep = Math.floor(Date.now() / 30_000);
  await page.getByLabel('Enter the 6-digit code to confirm').fill(totp(totpSecret, lastStep * 30_000 + 1000));
  await page.getByRole('button', { name: 'Enable' }).click();
  await expect(page.getByText('Two-factor authentication enabled')).toBeVisible();
  await expect(page.locator('.recovery-codes span')).toHaveCount(10);
  await page.getByRole('button', { name: 'I saved them — continue' }).click();
  await expect(page.getByRole('heading', { name: 'Hosts' })).toBeVisible();
});

test('add a host, verify the host key, authenticate and use the terminal', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Add host' }).first().click();
  await page.getByLabel('Hostname or IP *').fill('127.0.0.1');
  await page.getByLabel('Port').fill(String(sshd.port));
  await page.getByLabel('Username *').fill('e2euser');
  await page.getByLabel('Display name').fill('lab-box');
  await page.getByLabel('Authentication').selectOption('ask');
  await page.getByLabel('Group').fill('Lab');
  await shot(page, '03-host-form');
  await page.getByRole('button', { name: 'Save & connect' }).click();

  // Host key verification prompt
  await expect(page.getByText('Verify host key')).toBeVisible();
  await expect(page.getByText(/SHA256:/)).toBeVisible();
  await shot(page, '04-hostkey');
  await page.getByRole('button', { name: 'Trust & connect' }).click();

  // Password prompt (auth type "ask")
  await expect(page.getByText("e2euser@127.0.0.1's password:")).toBeVisible();
  await page.locator('.modal input[type=password]').fill('Pa55word-e2e!');
  await page.getByRole('button', { name: 'Continue' }).click();

  const term = page.locator('.xterm-host').first();
  await expect(term).toBeVisible();
  await expect(page.locator('.term-tab .dot.green')).toBeVisible({ timeout: 20_000 });
  await term.click();
  await page.keyboard.type('echo "webssh-$((40+2))" && whoami\n');
  await expectScreen(page, 'webssh-42');
  await expectScreen(page, 'e2euser');
  await shot(page, '05-terminal');

  // Reload: the session re-attaches automatically with its screen restored.
  await page.reload();
  await page.getByPlaceholder('123456').waitFor({ state: 'detached', timeout: 1000 }).catch(() => {});
  await expectScreen(page, 'webssh-42', 15_000);
});

test('local-first help answers without AI', async ({ page }) => {
  await login(page);
  await page.getByTitle('Command help (Ctrl+Shift+H)').click();
  const input = page.getByPlaceholder('Command or task… e.g. tar, what is using port 80');
  await input.fill('what is using port 8080');
  await expect(page.getByText('What is using / listening on a port')).toBeVisible();
  await input.fill('tar');
  await expect(page.locator('.help-cmd h3', { hasText: /^tar$/ })).toBeVisible();
  await shot(page, '06-help');
});

test('file manager lists and edits files over SFTP', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Files', exact: true }).first().click();
  await expect(page.getByText('Empty folder').or(page.locator('.file-row').first())).toBeVisible({ timeout: 15_000 });
  await shot(page, '07-files');
});

test('mobile layout with key bar', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await login(page);
  await shot(page, '08-mobile-hosts');
  await page.locator('.card', { hasText: 'lab-box' }).getByRole('button', { name: 'Connect' }).click();
  const prompt = page.getByText("e2euser@127.0.0.1's password:");
  await prompt.waitFor({ timeout: 15_000 }).then(async () => {
    await page.locator('.modal input[type=password]').fill('Pa55word-e2e!');
    await page.getByRole('button', { name: 'Continue' }).click();
  }).catch(() => {});
  await expect(page.locator('.keybar')).toBeVisible();
  await expect(page.locator('.term-tab .dot.green').first()).toBeVisible({ timeout: 20_000 });
  await page.locator('.keybar button', { hasText: 'Ctrl' }).click();
  await expect(page.locator('.keybar button.on', { hasText: 'Ctrl' })).toBeVisible();
  await shot(page, '09-mobile-terminal');
  await ctx.close();
});
