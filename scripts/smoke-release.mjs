#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const RELEASE_DIR = path.resolve(process.cwd(), 'release');
const HEALTH_TIMEOUT_MS = 45_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function findFirstJavaScriptFile(directory) {
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findFirstJavaScriptFile(entryPath);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      return entryPath;
    }
  }
  return null;
}

function assertHtmlBootstrap(response, html) {
  const scripts = [
    ...html.matchAll(
      /<script(?![^>]*\bsrc\s*=)(?:\s[^>]*)?>[\s\S]*?<\/script>/gi,
    ),
  ];
  if (scripts.length === 0)
    throw new Error('Packaged HTML contains no inline bootstrap script');

  const csp = response.headers.get('content-security-policy') || '';
  for (const [index, script] of scripts.entries()) {
    const openingTag = /^<script\b([^>]*)>/i.exec(script[0])?.[1] || '';
    const nonce = /\bnonce\s*=\s*(["'])(.*?)\1/i.exec(openingTag)?.[2];
    if (!nonce)
      throw new Error(`Packaged inline script ${index + 1} has no CSP nonce`);
    if (!csp.includes(`'nonce-${nonce}'`))
      throw new Error(`Packaged CSP does not authorize inline script ${index + 1}`);
  }
}

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child);
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    delay(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    }),
  ]);
}

async function waitForHealth(baseUrl, child, output) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Release binary exited before health became available:\n${output()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response;
      await response.arrayBuffer();
    } catch {
      // The binary can take a few seconds to initialize its database and services.
    }
    await delay(250);
  }
  throw new Error(
    `Release binary did not expose /api/health in ${HEALTH_TIMEOUT_MS}ms:\n${output()}`,
  );
}

async function waitForVisible(page, selector, label) {
  try {
    await page.locator(selector).waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    throw new Error(`Packaged auth smoke did not reach ${label}`);
  }
}

// Cookies scoped to /api/auth are not returned for the app root URL.
async function getRefreshCookie(context, baseUrl) {
  return (await context.cookies(new URL('/api/auth/refresh', baseUrl).href)).find(
    (cookie) => cookie.name === 'refreshToken',
  );
}

async function assertNoRefreshCookie(context, baseUrl) {
  const hasRefreshCookie = await getRefreshCookie(context, baseUrl);
  if (hasRefreshCookie) {
    throw new Error('Packaged auth smoke found a refresh cookie unexpectedly');
  }
}

async function assertRememberMeCookie(context, baseUrl) {
  const refreshCookie = await getRefreshCookie(context, baseUrl);
  if (!refreshCookie || !refreshCookie.httpOnly || refreshCookie.path !== '/api/auth') {
    throw new Error('Packaged auth smoke received an invalid remember-me cookie');
  }
  if (String(refreshCookie.sameSite).toLowerCase() !== 'strict') {
    throw new Error('Packaged auth smoke received a refresh cookie without SameSite=Strict');
  }
}

async function runAuthSmoke(baseUrl, setupToken) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const apiUrl = (pathname) => new URL(pathname, baseUrl).href;
  const password = 'release-smoke-password';
  const username = 'smokeadmin';
  const context = await browser.newContext({ baseURL: baseUrl });

  try {
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForVisible(page, '#setupToken', 'first-run setup');
    await page.locator('#setupToken').fill(setupToken);
    await page.locator('#username').fill(username);
    await page.locator('#panelPort').fill(new URL(baseUrl).port);
    await page.locator('#password').fill(password);
    await page.locator('#confirmPassword').fill(password);
    await page.getByRole('button', { name: 'Create account & continue' }).click();
    await waitForVisible(page, 'button[title="Sign out"]', 'authenticated dashboard after setup');

    await assertRememberMeCookie(context, baseUrl);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForVisible(page, 'button[title="Sign out"]', 'authenticated dashboard after hard reload');

    const logoutResponse = await context.request.post(apiUrl('/api/auth/logout'));
    if (!logoutResponse.ok()) {
      throw new Error(`Packaged auth smoke logout failed: ${logoutResponse.status()}`);
    }
    await assertNoRefreshCookie(context, baseUrl);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForVisible(page, '#login-form', 'login screen after logout');

    const noRememberContext = await browser.newContext({ baseURL: baseUrl });
    try {
      const noRememberPage = await noRememberContext.newPage();
      await noRememberPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await waitForVisible(noRememberPage, '#login-form', 'login screen');
      await noRememberPage.locator('#username').fill(username);
      await noRememberPage.locator('#password').fill(password);
      const rememberMe = noRememberPage.locator('#rememberMe');
      if ((await rememberMe.getAttribute('aria-checked')) === 'true') {
        await rememberMe.click();
      }
      await noRememberPage.getByRole('button', { name: 'Sign in' }).click();
      await waitForVisible(noRememberPage, 'button[title="Sign out"]', 'dashboard after non-persistent login');
      await assertNoRefreshCookie(noRememberContext, baseUrl);
      await noRememberPage.reload({ waitUntil: 'domcontentloaded' });
      await waitForVisible(noRememberPage, '#login-form', 'login after non-persistent hard reload');
    } finally {
      await noRememberContext.close();
    }

    const rememberedLogin = await context.request.post(apiUrl('/api/auth/login'), {
      data: { username, password, rememberMe: true },
    });
    if (!rememberedLogin.ok()) {
      throw new Error(`Packaged auth smoke persistent login failed: ${rememberedLogin.status()}`);
    }
    if (!(await getRefreshCookie(context, baseUrl))) {
      throw new Error('Packaged auth smoke did not receive a persistent login cookie');
    }

    const nonPersistentLogin = await context.request.post(apiUrl('/api/auth/login'), {
      data: { username, password, rememberMe: false },
    });
    if (!nonPersistentLogin.ok()) {
      throw new Error(`Packaged auth smoke non-persistent login failed: ${nonPersistentLogin.status()}`);
    }
    await assertNoRefreshCookie(context, baseUrl);
    const refreshAfterNonPersistentLogin = await context.request.post(apiUrl('/api/auth/refresh'));
    if (refreshAfterNonPersistentLogin.status() !== 401) {
      throw new Error(
        `Packaged auth smoke refresh unexpectedly succeeded after remember-me was disabled: ${refreshAfterNonPersistentLogin.status()}`,
      );
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const platform =
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'linux'
        ? 'linux'
        : null;
  if (!platform) {
    throw new Error(
      'scripts/smoke-release.mjs supports Linux and Windows packaged artifacts',
    );
  }

  const sourceBinary = path.join(
    RELEASE_DIR,
    platform === 'windows' ? 'ZomboidControlPanel.exe' : 'ZomboidControlPanel',
  );
  const sourceClient = path.join(RELEASE_DIR, 'client', 'dist');
  const manifestPath = path.join(RELEASE_DIR, 'release-manifest.json');
  if (
    !fs.existsSync(sourceBinary) ||
    !fs.existsSync(sourceClient) ||
    !fs.existsSync(manifestPath)
  ) {
    throw new Error(
      `release/ is missing the ${platform} binary, client, or release manifest`,
    );
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const sourceAsset = findFirstJavaScriptFile(
    path.join(sourceClient, 'assets'),
  );
  if (!sourceAsset)
    throw new Error('release/client/dist/assets contains no JavaScript asset');

  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'better-zcp-release-smoke-'),
  );
  const smokeReleaseDir = path.join(temporaryRoot, 'release');
  const authSmokeEnabled = process.env.RUN_AUTH_SMOKE === '1';
  const authSmokeSetupToken = 'release-smoke-setup-token';
  let child;
  let capturedOutput = '';
  const output = () => capturedOutput.slice(-32_000);

  try {
    fs.cpSync(RELEASE_DIR, smokeReleaseDir, { recursive: true });
    const port = await getFreePort();
    const binary = path.join(
      smokeReleaseDir,
      platform === 'windows'
        ? 'ZomboidControlPanel.exe'
        : 'ZomboidControlPanel',
    );
    child = spawn(binary, [], {
      cwd: smokeReleaseDir,
      env: {
        ...process.env,
        PANEL_NO_SUPERVISOR: '1',
        PORT: String(port),
        ...(authSmokeEnabled ? { SETUP_TOKEN: authSmokeSetupToken } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      capturedOutput = (capturedOutput + chunk.toString()).slice(-32_000);
    });
    child.stderr.on('data', (chunk) => {
      capturedOutput = (capturedOutput + chunk.toString()).slice(-32_000);
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const healthResponse = await waitForHealth(baseUrl, child, output);
    const health = await healthResponse.json();
    if (
      health.status !== 'ok' ||
      health.version !== manifest.version ||
      health.panelVersion !== manifest.version
    ) {
      throw new Error(
        `Packaged health metadata does not match the release manifest: ${JSON.stringify(health)}`,
      );
    }

    const pageResponse = await fetch(`${baseUrl}/`);
    const pageHtml = await pageResponse.text();
    if (!pageResponse.ok || !pageResponse.headers.get('content-type')?.includes('text/html')) {
      throw new Error(
        `Packaged HTML failed: status=${pageResponse.status}, content-type=${pageResponse.headers.get('content-type')}`,
      );
    }
    assertHtmlBootstrap(pageResponse, pageHtml);

    const assetPath = `/${path.relative(sourceClient, sourceAsset).split(path.sep).join('/')}`;
    const assetResponse = await fetch(`${baseUrl}${assetPath}`, {
      headers: { accept: 'text/javascript' },
    });
    if (
      !assetResponse.ok ||
      assetResponse.headers.get('content-type') !==
        'text/javascript; charset=utf-8'
    ) {
      throw new Error(
        `Packaged JavaScript asset failed: status=${assetResponse.status}, content-type=${assetResponse.headers.get('content-type')}`,
      );
    }
    if (!(await assetResponse.text()).trim())
      throw new Error('Packaged JavaScript asset was empty');

    const headResponse = await fetch(`${baseUrl}${assetPath}`, {
      method: 'HEAD',
    });
    if (!headResponse.ok)
      throw new Error(
        `Packaged JavaScript HEAD request failed: ${headResponse.status}`,
      );

    if (authSmokeEnabled) {
      await runAuthSmoke(baseUrl, authSmokeSetupToken);
    }

    console.log(
      `${platform} release smoke passed: ${manifest.version}, /api/health, ${assetPath} GET/HEAD${authSmokeEnabled ? ', browser auth persistence' : ''}`,
    );
  } finally {
    if (child) await stopChild(child);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    `Release smoke failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
