import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const expectedSha = '0123456789012345678901234567890123456789';

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function createMockServer({ failFirstStart = false } = {}) {
  let running = true;
  let startAttempts = 0;
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(url.pathname);
    const authenticated =
      request.headers.authorization === 'Bearer access-token';
    const hasRefreshCookie = request.headers.cookie?.includes(
      'refreshToken=refresh-token',
    );
    const protectedRoutes = new Set([
      '/api/servers',
      '/api/servers/active/status',
      '/api/server/status',
      '/api/rcon/health',
      '/api/rcon/commands',
      '/api/rcon/execute',
      '/api/server/console-log',
      '/api/panel-bridge/status',
      '/api/panel-bridge/ping',
      '/api/server/steamcmd/detect',
      '/api/server/branches',
      '/api/auth/me',
    ]);

    request.resume();
    request.on('end', () => {
      if (protectedRoutes.has(url.pathname) && !authenticated) {
        return json(response, 401, { error: 'unauthorized' });
      }
      if (url.pathname === '/api/health') {
        return json(response, 200, { status: 'ok', buildSha: expectedSha });
      }
      if (url.pathname === '/api/servers') {
        return json(response, 200, {
          servers: [{ id: 'server-1', isActive: true }],
        });
      }
      if (url.pathname === '/api/auth/status') {
        return json(response, 200, { authEnabled: true });
      }
      if (url.pathname === '/api/auth/login') {
        return json(
          response,
          200,
          { accessToken: 'access-token', user: { username: 'admin' } },
          { 'set-cookie': 'refreshToken=refresh-token; Path=/; HttpOnly' },
        );
      }
      if (url.pathname === '/api/auth/refresh') {
        return hasRefreshCookie
          ? json(response, 200, { accessToken: 'access-token' })
          : json(response, 401, { error: 'unauthorized' });
      }
      if (url.pathname === '/api/auth/me') {
        return json(response, 200, { user: { username: 'admin' } });
      }
      if (url.pathname === '/api/servers/active/status') {
        return json(response, 200, { server: { id: 'server-1' } });
      }
      if (url.pathname === '/api/server/status') {
        return json(response, 200, { running });
      }
      if (url.pathname === '/api/rcon/health')
        return json(response, 200, { success: true });
      if (url.pathname === '/api/rcon/commands') {
        return json(response, 200, { commands: { players: {} } });
      }
      if (url.pathname === '/api/rcon/execute')
        return json(response, 200, { success: true });
      if (url.pathname === '/api/server/console-log') {
        return json(response, 200, { success: true });
      }
      if (url.pathname === '/api/panel-bridge/status') {
        return json(response, 200, { modConnected: true });
      }
      if (url.pathname === '/api/panel-bridge/ping') {
        return json(response, 200, { success: true });
      }
      if (url.pathname === '/api/server/steamcmd/detect') {
        return json(response, 200, { found: true });
      }
      if (url.pathname === '/api/server/branches') {
        return json(response, 200, { branches: [{ name: 'public' }] });
      }
      if (url.pathname === '/api/server/stop') {
        running = false;
        return json(response, 200, { success: true });
      }
      if (url.pathname === '/api/server/start') {
        startAttempts += 1;
        if (failFirstStart && startAttempts === 1) {
          return json(response, 503, { error: 'simulated start failure' });
        }
        running = true;
        return json(response, 200, { success: true });
      }
      return json(response, 404, { error: 'not found' });
    });
  });
  return {
    server,
    requests,
    get running() {
      return running;
    },
  };
}

async function runAcceptance(mock, tempDir) {
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const { port } = mock.server.address();
  const evidencePath = path.join(tempDir, 'evidence.json');
  const child = spawn(process.execPath, ['scripts/acceptance-release.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ZCP_ACCEPTANCE_GATE: '0',
      ZCP_ACCEPTANCE_URL: `http://127.0.0.1:${port}`,
      ZCP_ACCEPTANCE_USERNAME: 'admin',
      ZCP_ACCEPTANCE_PASSWORD: 'secret',
      ZCP_ACCEPTANCE_PLATFORM: 'linux',
      ZCP_ACCEPTANCE_DEPLOYMENT: 'native-linux',
      ZCP_ACCEPTANCE_EXPECTED_BUILD_SHA: expectedSha,
      ZCP_ACCEPTANCE_OWNER: 'test',
      ZCP_ACCEPTANCE_PZ_BUILD_ID: '123',
      ZCP_ACCEPTANCE_REQUIRE_BRIDGE: '1',
      ZCP_ACCEPTANCE_CORS_MODE: 'same-origin',
      ZCP_ACCEPTANCE_TEST_STEAMCMD: '1',
      ZCP_ACCEPTANCE_TEST_LIFECYCLE: '1',
      ZCP_ACCEPTANCE_ALLOW_DESTRUCTIVE: '1',
      ZCP_ACCEPTANCE_EVIDENCE_PATH: evidencePath,
      ZCP_ACCEPTANCE_TIMEOUT_MS: '5000',
      ZCP_ACCEPTANCE_LIFECYCLE_TIMEOUT_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  await new Promise((resolve) => mock.server.close(resolve));
  return {
    exitCode,
    stdout,
    stderr,
    evidence: JSON.parse(fs.readFileSync(evidencePath, 'utf8')),
  };
}

async function withTempDir(callback) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'better-zcp-acceptance-test-'),
  );
  try {
    return await callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('real acceptance passes the required mock matrix and restores lifecycle state', async () => {
  await withTempDir(async (tempDir) => {
    const mock = createMockServer();
    const result = await runAcceptance(mock, tempDir);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(result.evidence.result, 'passed');
    assert.ok(
      result.evidence.checks.every((check) => check.status === 'passed'),
    );
    assert.equal(mock.running, true);
    assert.ok(mock.requests.includes('/api/server/stop'));
    assert.ok(mock.requests.includes('/api/server/start'));
  });
});

test('real acceptance attempts cleanup after a failed restart', async () => {
  await withTempDir(async (tempDir) => {
    const mock = createMockServer({ failFirstStart: true });
    const result = await runAcceptance(mock, tempDir);
    assert.equal(result.exitCode, 1, result.stdout);
    assert.equal(result.evidence.result, 'failed');
    assert.equal(mock.running, true);
    assert.equal(
      result.evidence.checks.find(
        (check) => check.name === 'Server cleanup restart',
      )?.status,
      'passed',
    );
  });
});
