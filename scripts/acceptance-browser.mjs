#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const env = process.env;
const required = (name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const timeoutMs = Number(env.ZCP_ACCEPTANCE_BROWSER_TIMEOUT_MS || 30_000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
  throw new Error('ZCP_ACCEPTANCE_BROWSER_TIMEOUT_MS must be at least 1000');
}

function errorText(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/(password|token|authorization|cookie)[^\s]*/gi, '$1=[redacted]')
    .replace(/[A-Z]:\\[^\s]+/gi, '[path]')
    .replace(
      /\/(?:home|opt|usr|var|tmp|srv|root|etc|mnt|media)\/[^\s]+/gi,
      '[path]',
    );
}

function refreshCookie(cookies) {
  return cookies.find(
    (cookie) => cookie.name === 'refreshToken' && cookie.path === '/',
  );
}

const baseUrl = required('ZCP_ACCEPTANCE_URL').replace(/\/$/, '');
const parsedBaseUrl = new URL(baseUrl);
if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
  throw new Error('ZCP_ACCEPTANCE_URL must use http or https');
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  let serverFunctionRequests = 0;
  let successfulServerFunctionResponses = 0;
  let refreshResponse = null;
  let protectedResponsesAfterReload = 0;
  let afterReload = false;

  page.on('request', (request) => {
    try {
      if (new URL(request.url()).pathname.startsWith('/_serverFn/')) {
        serverFunctionRequests += 1;
      }
    } catch {
      // Ignore malformed third-party URLs; the panel URL is validated above.
    }
  });
  page.on('response', (response) => {
    try {
      const pathname = new URL(response.url()).pathname;
      if (pathname.startsWith('/_serverFn/') && response.ok()) {
        successfulServerFunctionResponses += 1;
      }
      if (afterReload && pathname === '/api/servers' && response.ok()) {
        protectedResponsesAfterReload += 1;
      }
    } catch {
      // Ignore malformed third-party URLs; the panel URL is validated above.
    }
  });

  await page.goto(`${baseUrl}/`, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });
  await page
    .locator('#login-form')
    .waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('#username').fill(required('ZCP_ACCEPTANCE_USERNAME'));
  await page.locator('#password').fill(required('ZCP_ACCEPTANCE_PASSWORD'));
  await page.locator('#login-form button[type="submit"]').click();
  await page
    .locator('#main-content')
    .waitFor({ state: 'visible', timeout: timeoutMs });
  assert.equal(
    await page.locator('#login-form').count(),
    0,
    'login form remained after browser login',
  );
  assert.ok(
    serverFunctionRequests > 0,
    'browser did not invoke a TanStack Start server function',
  );
  assert.ok(
    successfulServerFunctionResponses > 0,
    'TanStack Start server functions did not return a successful response',
  );

  const beforeReload = refreshCookie(await context.cookies(baseUrl));
  assert.ok(beforeReload, 'browser login did not persist the refresh cookie');
  assert.equal(beforeReload.httpOnly, true, 'refresh cookie must be HttpOnly');

  afterReload = true;
  [refreshResponse] = await Promise.all([
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/auth/refresh',
      { timeout: timeoutMs },
    ),
    page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs }),
  ]);
  assert.equal(
    refreshResponse.status(),
    200,
    'browser refresh did not restore the session',
  );
  await page
    .locator('#main-content')
    .waitFor({ state: 'visible', timeout: timeoutMs });
  assert.equal(
    await page.locator('#login-form').count(),
    0,
    'hard refresh returned the browser to login',
  );
  assert.ok(
    protectedResponsesAfterReload > 0,
    'hard refresh did not load a protected dashboard API response',
  );

  const afterReloadCookie = refreshCookie(await context.cookies(baseUrl));
  assert.ok(afterReloadCookie, 'refresh cookie disappeared after hard reload');
  assert.equal(
    afterReloadCookie.httpOnly,
    true,
    'refresh cookie lost HttpOnly protection after reload',
  );
  console.log(
    'PASS browser login, Start RPC, refresh, and protected dashboard reload',
  );
} catch (error) {
  console.error(`FAIL browser acceptance: ${errorText(error)}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
