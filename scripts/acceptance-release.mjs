#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HELP = `
Run the real Project Zomboid release acceptance checks against a deployed panel.

Required environment:
  ZCP_ACCEPTANCE_URL                  panel URL
  ZCP_ACCEPTANCE_USERNAME             disposable admin username
  ZCP_ACCEPTANCE_PASSWORD             disposable admin password
  ZCP_ACCEPTANCE_PLATFORM             linux or windows
  ZCP_ACCEPTANCE_DEPLOYMENT           native-linux, native-windows, docker-all-in-one, or remote-rcon-sftp
  ZCP_ACCEPTANCE_EXPECTED_BUILD_SHA   build SHA served by the target artifact
  ZCP_ACCEPTANCE_PZ_BUILD_ID          installed Steam app build ID, unless an install path is supplied
  ZCP_ACCEPTANCE_OWNER                operator responsible for the target
  ZCP_ACCEPTANCE_REQUIRE_BRIDGE       1 or 0

Optional environment:
  ZCP_ACCEPTANCE_PZ_INSTALL_PATH      local PZ install path on the acceptance runner
  ZCP_ACCEPTANCE_EXPECTED_PANEL_VERSION
  ZCP_ACCEPTANCE_CORS_ORIGIN          origin to verify through a reverse proxy
  ZCP_ACCEPTANCE_TEST_STEAMCMD        1 to check SteamCMD discovery and branch lookup
  ZCP_ACCEPTANCE_TEST_LIFECYCLE       1 to stop and start the disposable server
  ZCP_ACCEPTANCE_ALLOW_DESTRUCTIVE    1 is required when lifecycle checks are enabled
  ZCP_ACCEPTANCE_SERVER_ID            managed server ID to select
  ZCP_ACCEPTANCE_EVIDENCE_PATH        JSON output path
  ZCP_ACCEPTANCE_GATE                 1 to enforce release-gate metadata and lifecycle checks
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP.trim());
  process.exit(0);
}

const env = process.env;
const one = (name) => env[name] === '1';
const requiredValue = (name) => {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};
const required = (name) => requiredValue(name).trim();

const timeoutMs = Number(env.ZCP_ACCEPTANCE_TIMEOUT_MS || 30_000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
  throw new Error('ZCP_ACCEPTANCE_TIMEOUT_MS must be at least 1000');
}

const configuredEvidencePath = env.ZCP_ACCEPTANCE_EVIDENCE_PATH?.trim();
const evidencePath =
  configuredEvidencePath ||
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'better-zcp-')), 'real-acceptance.json');
const evidence = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  result: 'running',
  target: {
    url: null,
    platform: env.ZCP_ACCEPTANCE_PLATFORM || null,
    deployment: env.ZCP_ACCEPTANCE_DEPLOYMENT || null,
    owner: env.ZCP_ACCEPTANCE_OWNER || null,
    expectedBuildSha: env.ZCP_ACCEPTANCE_EXPECTED_BUILD_SHA || null,
    expectedPanelVersion: env.ZCP_ACCEPTANCE_EXPECTED_PANEL_VERSION || null,
    expectedPzBuildId: env.ZCP_ACCEPTANCE_PZ_BUILD_ID || null,
    hasLocalPzInstall: Boolean(env.ZCP_ACCEPTANCE_PZ_INSTALL_PATH?.trim()),
    serverId: env.ZCP_ACCEPTANCE_SERVER_ID || null,
  },
  checks: [],
};

let baseUrl;
let accessToken = null;
let refreshCookie = null;

function safeTargetUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function errorText(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/(password|token|authorization|cookie)[^\s]*/gi, '$1=[redacted]')
    .replace(/[A-Z]:\\[^\s]+/gi, '[path]')
    .replace(/\/(?:home|opt|usr|var|tmp|srv|root|etc|mnt|media)\/[^\s]+/gi, '[path]');
}

function bodySummary(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const keys = [
    'status',
    'success',
    'error',
    'code',
    'connected',
    'running',
    'state',
    'message',
  ];
  const summary = Object.fromEntries(
    keys.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]),
  );
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function setCookieHeaders(response) {
  const getSetCookie = response.headers.getSetCookie;
  if (typeof getSetCookie === 'function') return getSetCookie.call(response.headers);
  const combined = response.headers.get('set-cookie');
  return combined ? [combined] : [];
}

function findCookie(headers, name) {
  for (const header of headers) {
    const match = new RegExp(`^${name}=([^;]+)`).exec(header.trim());
    if (match) return `${name}=${match[1]}`;
  }
  return null;
}

async function request(route, { method = 'GET', body, auth = true, cookie, origin } = {}) {
  const headers = { accept: 'application/json' };
  if (auth && accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(new URL(route, baseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { response, status: response.status, body: parsed };
}

function expectStatus(result, expected = 200) {
  if (result.status !== expected) {
    const summary = bodySummary(result.body);
    throw new Error(
      `expected HTTP ${expected}, got ${result.status}${summary ? ` ${JSON.stringify(summary)}` : ''}`,
    );
  }
}

function expectObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} did not return a JSON object`);
  }
}

async function check(name, action) {
  const started = Date.now();
  try {
    await action();
    evidence.checks.push({
      name,
      status: 'passed',
      durationMs: Date.now() - started,
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = errorText(error);
    evidence.checks.push({
      name,
      status: 'failed',
      durationMs: Date.now() - started,
      error: 'check failed',
    });
    console.error(`FAIL ${name}: ${message}`);
    throw error;
  }
}

function skip(name, reason) {
  evidence.checks.push({ name, status: 'skipped', reason });
  console.log(`SKIP ${name}: ${reason}`);
}

async function waitForServerState(running) {
  const deadline = Date.now() + Number(env.ZCP_ACCEPTANCE_LIFECYCLE_TIMEOUT_MS || 180_000);
  while (Date.now() < deadline) {
    const result = await request('/api/server/status');
    if (result.status === 200 && result.body?.running === running) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`server did not become ${running ? 'running' : 'stopped'} before the timeout`);
}

function readPzBuild() {
  const installPath = env.ZCP_ACCEPTANCE_PZ_INSTALL_PATH?.trim();
  if (!installPath) {
    return env.ZCP_ACCEPTANCE_PZ_BUILD_ID?.trim()
      ? { buildId: env.ZCP_ACCEPTANCE_PZ_BUILD_ID.trim(), source: 'operator-declared' }
      : null;
  }

  const manifestPath = path.join(installPath, 'steamapps', 'appmanifest_380870.acf');
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  const valueFor = (key) => manifest.match(new RegExp(`"${key}"\\s+"([^"]+)"`))?.[1] || null;
  return {
    buildId: valueFor('buildid'),
    branch: valueFor('BetaKey') || 'public',
    source: 'local-manifest',
  };
}

async function main() {
  const requiredNames = [
    'ZCP_ACCEPTANCE_URL',
    'ZCP_ACCEPTANCE_USERNAME',
    'ZCP_ACCEPTANCE_PASSWORD',
    'ZCP_ACCEPTANCE_PLATFORM',
    'ZCP_ACCEPTANCE_DEPLOYMENT',
    'ZCP_ACCEPTANCE_EXPECTED_BUILD_SHA',
    'ZCP_ACCEPTANCE_OWNER',
  ];
  for (const name of requiredNames) required(name);

  baseUrl = required('ZCP_ACCEPTANCE_URL').replace(/\/$/, '');
  const parsedBaseUrl = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
    throw new Error('ZCP_ACCEPTANCE_URL must use http or https');
  }
  evidence.target.url = safeTargetUrl(baseUrl);

  const platform = required('ZCP_ACCEPTANCE_PLATFORM');
  if (!['linux', 'windows'].includes(platform)) {
    throw new Error('ZCP_ACCEPTANCE_PLATFORM must be linux or windows');
  }
  const deployment = required('ZCP_ACCEPTANCE_DEPLOYMENT');
  if (!['native-linux', 'native-windows', 'docker-all-in-one', 'remote-rcon-sftp'].includes(deployment)) {
    throw new Error(`unsupported ZCP_ACCEPTANCE_DEPLOYMENT: ${deployment}`);
  }
  const requireBridgeValue = env.ZCP_ACCEPTANCE_REQUIRE_BRIDGE;
  if (!['0', '1'].includes(requireBridgeValue)) {
    throw new Error('ZCP_ACCEPTANCE_REQUIRE_BRIDGE must be 0 or 1');
  }

  const gate = one('ZCP_ACCEPTANCE_GATE');
  const lifecycle = one('ZCP_ACCEPTANCE_TEST_LIFECYCLE');
  const steamcmd = one('ZCP_ACCEPTANCE_TEST_STEAMCMD');
  if (gate) {
    const pzBuild = readPzBuild();
    if (!pzBuild?.buildId) {
      throw new Error(
        'The release gate needs ZCP_ACCEPTANCE_PZ_BUILD_ID or a readable ZCP_ACCEPTANCE_PZ_INSTALL_PATH',
      );
    }
    if (deployment !== 'remote-rcon-sftp' && (!lifecycle || !one('ZCP_ACCEPTANCE_ALLOW_DESTRUCTIVE'))) {
      throw new Error(
        'Native and Docker release-gate targets must set ZCP_ACCEPTANCE_TEST_LIFECYCLE=1 and ZCP_ACCEPTANCE_ALLOW_DESTRUCTIVE=1',
      );
    }
    if (deployment !== 'remote-rcon-sftp' && !steamcmd) {
      throw new Error('Native and Docker release-gate targets must set ZCP_ACCEPTANCE_TEST_STEAMCMD=1');
    }
  }

  await check('Project Zomboid build identity', async () => {
    const build = readPzBuild();
    if (!build?.buildId) throw new Error('Project Zomboid build ID could not be read');
    const expected = env.ZCP_ACCEPTANCE_PZ_BUILD_ID?.trim();
    if (expected && build.buildId !== expected) {
      throw new Error(`expected PZ build ${expected}, got ${build.buildId}`);
    }
    evidence.target.observedPzBuildId = build.buildId;
    evidence.target.pzBranch = build.branch || null;
    evidence.target.pzBuildSource = build.source;
    return { buildId: build.buildId, branch: build.branch || null };
  });

  await check('Panel health and artifact identity', async () => {
    const result = await request('/api/health', { auth: false });
    expectStatus(result);
    expectObject(result.body, 'health');
    if (result.body.status !== 'ok') throw new Error('health status was not ok');
    const expectedSha = required('ZCP_ACCEPTANCE_EXPECTED_BUILD_SHA');
    if (result.body.buildSha !== expectedSha) {
      throw new Error(`expected artifact ${expectedSha}, got ${result.body.buildSha || 'no build SHA'}`);
    }
    const expectedVersion = env.ZCP_ACCEPTANCE_EXPECTED_PANEL_VERSION?.trim();
    if (expectedVersion && result.body.version !== expectedVersion) {
      throw new Error(`expected panel ${expectedVersion}, got ${result.body.version || 'no version'}`);
    }
    evidence.target.observedBuildSha = expectedSha;
    if (expectedVersion) evidence.target.observedPanelVersion = expectedVersion;
  });

  await check('Unauthenticated API rejection', async () => {
    const result = await request('/api/servers', { auth: false });
    expectStatus(result, 401);
  });

  await check('Authentication status', async () => {
    const result = await request('/api/auth/status', { auth: false });
    expectStatus(result);
    if (result.body?.authEnabled === false) {
      throw new Error('authentication is disabled on the acceptance target');
    }
  });

  await check('Admin login', async () => {
    const result = await request('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: {
        username: required('ZCP_ACCEPTANCE_USERNAME'),
        password: requiredValue('ZCP_ACCEPTANCE_PASSWORD'),
        rememberMe: true,
      },
    });
    expectStatus(result);
    if (typeof result.body?.accessToken !== 'string' || !result.body.accessToken) {
      throw new Error('login did not return an access token');
    }
    accessToken = result.body.accessToken;
    refreshCookie = findCookie(setCookieHeaders(result.response), 'refreshToken');
    if (!refreshCookie) throw new Error('login did not return a refresh cookie');
  });

  await check('Refresh session', async () => {
    const result = await request('/api/auth/refresh', {
      method: 'POST',
      auth: false,
      cookie: refreshCookie,
    });
    expectStatus(result);
    if (typeof result.body?.accessToken !== 'string' || !result.body.accessToken) {
      throw new Error('refresh did not return an access token');
    }
    accessToken = result.body.accessToken;
    refreshCookie = findCookie(setCookieHeaders(result.response), 'refreshToken') || refreshCookie;
  });

  await check('Authenticated user', async () => {
    const result = await request('/api/auth/me');
    expectStatus(result);
    if (!result.body?.user?.username) throw new Error('authenticated user was missing');
  });

  let selectedServerId = null;
  await check('Managed server discovery', async () => {
    const result = await request('/api/servers');
    expectStatus(result);
    if (!Array.isArray(result.body?.servers) || result.body.servers.length === 0) {
      throw new Error('no managed server is configured');
    }
    const requestedId = env.ZCP_ACCEPTANCE_SERVER_ID?.trim();
    const selected = requestedId
      ? result.body.servers.find((server) => String(server.id) === requestedId)
      : result.body.servers.find((server) => server.isActive) || result.body.servers[0];
    if (!selected) throw new Error(`managed server ${requestedId} was not found`);
    if (selected.isActive !== true) throw new Error(`managed server ${selected.id} is not active`);
    selectedServerId = String(selected.id);
  });

  await check('Active server status', async () => {
    const result = await request('/api/servers/active/status');
    expectStatus(result);
    if (!result.body?.server) throw new Error('active status did not identify a server');
  });

  await check('Server process status', async () => {
    const result = await request('/api/server/status');
    expectStatus(result);
    if (typeof result.body?.running !== 'boolean' && typeof result.body?.scanFailed !== 'boolean') {
      throw new Error('server status did not return a process state');
    }
  });

  await check('RCON connection', async () => {
    const result = await request('/api/rcon/health');
    expectStatus(result);
    if (result.body?.success !== true) throw new Error('RCON health did not report success');
  });

  await check('RCON command catalog', async () => {
    const result = await request('/api/rcon/commands');
    expectStatus(result);
    const commands = result.body?.commands;
    if (!commands || typeof commands !== 'object' || Object.keys(commands).length === 0) {
      throw new Error('RCON command catalog was empty');
    }
  });

  await check('Live RCON command', async () => {
    const result = await request('/api/rcon/execute', {
      method: 'POST',
      body: { command: 'players' },
    });
    expectStatus(result);
    if (result.body?.success === false) throw new Error('the live players command was rejected');
  });

  await check('Server console log', async () => {
    const result = await request('/api/server/console-log?lines=20');
    expectStatus(result);
    if (result.body?.success !== true) throw new Error('console log endpoint did not report success');
  });

  if (env.ZCP_ACCEPTANCE_CORS_ORIGIN?.trim()) {
    await check('Configured CORS origin', async () => {
      const origin = env.ZCP_ACCEPTANCE_CORS_ORIGIN.trim();
      const result = await request('/api/health', { auth: false, origin });
      expectStatus(result);
      const allowed = result.response.headers.get('access-control-allow-origin');
      if (allowed !== origin) throw new Error(`expected Access-Control-Allow-Origin ${origin}, got ${allowed || 'none'}`);
    });
  } else {
    skip('Configured CORS origin', 'ZCP_ACCEPTANCE_CORS_ORIGIN was not set');
  }

  if (env.ZCP_ACCEPTANCE_REQUIRE_BRIDGE === '1') {
    await check('PanelBridge status', async () => {
      const result = await request('/api/panel-bridge/status');
      expectStatus(result);
      if (result.body?.modConnected !== true) throw new Error('PanelBridge mod is not connected');
    });

    await check('PanelBridge ping', async () => {
      const result = await request('/api/panel-bridge/ping');
      expectStatus(result);
      if (result.body?.success !== true) throw new Error('PanelBridge ping did not report success');
    });
  } else {
    skip('PanelBridge status and ping', 'this acceptance target is classified without PanelBridge');
  }

  if (steamcmd) {
    await check('SteamCMD discovery', async () => {
      const result = await request('/api/server/steamcmd/detect');
      expectStatus(result);
      if (result.body?.found !== true) throw new Error('SteamCMD was not found by the panel');
    });

    await check('SteamCMD branch lookup', async () => {
      const result = await request('/api/server/branches');
      expectStatus(result);
      if (!Array.isArray(result.body?.branches) || result.body.branches.length === 0) {
        throw new Error('SteamCMD returned no Project Zomboid branches');
      }
    });
  } else {
    skip('SteamCMD discovery and branch lookup', 'ZCP_ACCEPTANCE_TEST_STEAMCMD was not set');
  }

  if (lifecycle) {
    if (!one('ZCP_ACCEPTANCE_ALLOW_DESTRUCTIVE')) {
      throw new Error('lifecycle checks require ZCP_ACCEPTANCE_ALLOW_DESTRUCTIVE=1');
    }
    await check('Server stop', async () => {
      const result = await request('/api/server/stop', { method: 'POST', body: {} });
      expectStatus(result);
      await waitForServerState(false);
    });

    await check('Server start', async () => {
      const result = await request('/api/server/start', { method: 'POST', body: {} });
      expectStatus(result);
      await waitForServerState(true);
      const rcon = await request('/api/rcon/health');
      expectStatus(rcon);
      if (rcon.body?.success !== true) throw new Error('RCON did not recover after server start');
      if (env.ZCP_ACCEPTANCE_REQUIRE_BRIDGE === '1') {
        const bridge = await request('/api/panel-bridge/ping');
        expectStatus(bridge);
        if (bridge.body?.success !== true) throw new Error('PanelBridge did not recover after server start');
      }
    });
  } else {
    skip('Server stop and start', 'ZCP_ACCEPTANCE_TEST_LIFECYCLE was not set');
  }

  console.log(`Acceptance passed for ${selectedServerId}`);
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
} finally {
  evidence.result = failure ? 'failed' : 'passed';
  evidence.finishedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    console.log(`Evidence written to ${evidencePath}`);
  } catch (error) {
    console.error(`Could not write acceptance evidence: ${errorText(error)}`);
    failure ||= error;
  }
}

if (failure) {
  console.error(`Real acceptance failed: ${errorText(failure)}`);
  process.exitCode = 1;
}
