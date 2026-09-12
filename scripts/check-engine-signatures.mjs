#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveAllCallSites, SEED_GLOBALS, STATIC_CLASS_SEEDS } from './lib/engine-signature-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : null;
}

const LUA_PATH = argValue('--lua') || path.join(ROOT, 'integrations/panelbridge/PanelBridge/media/lua/server/PanelBridge.lua');
const MANIFEST_PATH = argValue('--manifest') || path.join(__dirname, 'engine-signatures.manifest.json');
const BASELINE_PATH = argValue('--baseline') || path.join(__dirname, 'engine-signatures.baseline.json');
const REQUIRE_FRESH_MANIFEST = process.argv.includes('--require-fresh-manifest') || process.env.REQUIRE_FRESH_ENGINE_SIGNATURES === '1';
const EXPECTED_PZ_BUILD_ID = argValue('--expected-pz-build-id') || process.env.EXPECTED_PZ_BUILD_ID || null;

if (!fs.existsSync(MANIFEST_PATH)) {
  console.error(`Missing ${path.relative(ROOT, MANIFEST_PATH)} -- run scripts/gen-engine-signatures.mjs (needs a local JDK) and commit its output.`);
  process.exit(1);
}
if (!fs.existsSync(LUA_PATH)) {
  console.error(`Missing ${path.relative(ROOT, LUA_PATH)}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const rawSrc = fs.readFileSync(LUA_PATH, 'utf8');

let baselineEntries = [];
if (fs.existsSync(BASELINE_PATH)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    baselineEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (err) {
    console.error(`Malformed baseline at ${path.relative(ROOT, BASELINE_PATH)}: ${err.message}`);
    process.exit(1);
  }
}
const baselineKey = (className, methodName) => `${className}#${methodName}`;
const baselineByKey = new Map(baselineEntries.map((e) => [baselineKey(e.class, e.method), e]));

for (const key of Object.keys(SEED_GLOBALS)) delete SEED_GLOBALS[key];
Object.assign(SEED_GLOBALS, manifest.seedGlobals || {});
for (const key of Object.keys(STATIC_CLASS_SEEDS)) delete STATIC_CLASS_SEEDS[key];
Object.assign(STATIC_CLASS_SEEDS, manifest.staticClassSeeds || {});

function classProvider(className, methodName) {
  const info = manifest.classes[className];
  if (!info) return null;
  const sigs = info.methods[methodName];
  if (!sigs || sigs.length === 0) return { exists: false };
  return { exists: true, returnClass: sigs[0].returnClass, elementClass: sigs[0].elementClass };
}

const { callSites } = resolveAllCallSites(rawSrc, classProvider);

const resolved = callSites.filter((s) => s.resolved);
const unresolved = callSites.filter((s) => !s.resolved);
const absent = resolved.filter((s) => s.methodInfo && s.methodInfo.exists === false);
const staleClassLookups = resolved.filter((s) => s.methodInfo === null);

const skipReasonCounts = new Map();
for (const s of unresolved) {
  skipReasonCounts.set(s.skipReason, (skipReasonCounts.get(s.skipReason) || 0) + 1);
}

const MIN_CALL_SITES = 200;
if (callSites.length < MIN_CALL_SITES) {
  console.error(
    `ERROR: found only ${callSites.length} engine call site(s) in ${path.relative(ROOT, LUA_PATH)} ` +
    `(expected at least ${MIN_CALL_SITES}). resolveAllCallSites()'s extraction is almost certainly broken ` +
    `or was pointed at the wrong/an empty file -- fix it before trusting this script's output.`,
  );
  process.exit(1);
}

console.log('=== engine signature check (scripts/check-engine-signatures.mjs) ===');
console.log(`manifest:              ${path.relative(ROOT, MANIFEST_PATH)} (generated ${manifest.generatedAt}, ${manifest.jarBasename}, build ${manifest.jarBuildId || 'unknown'})`);
console.log(`source:                ${path.relative(ROOT, LUA_PATH)}`);

if (REQUIRE_FRESH_MANIFEST) {
  if (!manifest.jarBuildId || !/^[0-9]+$/.test(String(manifest.jarBuildId))) {
    console.error('FAIL: the release gate requires a manifest tied to a Project Zomboid build ID. Regenerate it from the target server jar.');
    process.exit(1);
  }
  if (!manifest.jarFileSha256 || !/^[0-9a-f]{64}$/i.test(manifest.jarFileSha256)) {
    console.error('FAIL: the release gate requires the manifest to record the source jar SHA-256. Regenerate it with the current generator.');
    process.exit(1);
  }
  if (EXPECTED_PZ_BUILD_ID && String(manifest.jarBuildId) !== EXPECTED_PZ_BUILD_ID.trim()) {
    console.error(`FAIL: the manifest targets PZ build ${manifest.jarBuildId}, but the acceptance target requires ${EXPECTED_PZ_BUILD_ID.trim()}.`);
    process.exit(1);
  }
}

const currentSha = crypto.createHash('sha256').update(rawSrc).digest('hex');
if (manifest.sourceFileSha256 && manifest.sourceFileSha256 !== currentSha) {
  console.log('');
  console.log('WARNING: PanelBridge.lua has changed since the manifest was generated.');
  console.log('  The ordinary check continues for diagnostics, but the release gate fails below.');
  console.log('  Any NEW call site this edit introduced is checked only if it happens to reuse a');
  console.log('  class already in the manifest. Run');
  console.log('  `node scripts/gen-engine-signatures.mjs` locally and commit the refreshed manifest.');
  if (REQUIRE_FRESH_MANIFEST) {
    console.error('FAIL: the release gate requires a fresh engine signature manifest.');
    process.exit(1);
  }
}

console.log('');
console.log(`call sites found:      ${callSites.length}`);
console.log(`receivers resolved:    ${resolved.length}`);
console.log(`  of which in manifest:      ${resolved.length - staleClassLookups.length}`);
console.log(`  of which stale (class not in manifest, not checked): ${staleClassLookups.length}`);
console.log(`skipped (unresolved):  ${unresolved.length}`);
for (const [reason, count] of [...skipReasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${reason}`);
}
console.log(`ABSENT methods found:  ${absent.length}`);

const baselined = [];
const newAbsent = [];
const matchedBaselineKeys = new Set();
for (const f of absent) {
  const entry = baselineByKey.get(baselineKey(f.receiverType, f.methodName));
  if (entry) {
    baselined.push({ finding: f, entry });
    matchedBaselineKeys.add(baselineKey(entry.class, entry.method));
  } else {
    newAbsent.push(f);
  }
}

if (baselined.length > 0) {
  const byCategory = new Map();
  for (const { finding, entry } of baselined) {
    const list = byCategory.get(entry.category) || [];
    list.push({ finding, entry });
    byCategory.set(entry.category, list);
  }
  console.log('');
  console.log(`already-baselined (see ${path.relative(ROOT, BASELINE_PATH)}): ${baselined.length} call site(s) across ${matchedBaselineKeys.size} entries`);
  for (const [category, items] of byCategory) {
    console.log(`  ${category} (${items.length} site(s)):`);
    for (const { finding, entry } of items) {
      console.log(`    PanelBridge.lua:${finding.line}  ${finding.receiverExpr} (${finding.receiverType}) has no ${finding.methodName}() -- ${entry.reason}`);
    }
  }
}

const unmatchedBaselineEntries = baselineEntries.filter((e) => !matchedBaselineKeys.has(baselineKey(e.class, e.method)));
if (unmatchedBaselineEntries.length > 0) {
  console.log('');
  console.log(`NOTE: ${unmatchedBaselineEntries.length} baseline entr${unmatchedBaselineEntries.length === 1 ? 'y' : 'ies'} matched nothing this run (does not fail the gate -- the call site may have been removed or fixed; safe to delete from the baseline once confirmed):`);
  for (const e of unmatchedBaselineEntries) {
    console.log(`  ${e.class}#${e.method}`);
  }
}

if (newAbsent.length > 0) {
  console.log('');
  console.log('NEW (not in the baseline) -- javap confirms no such method anywhere in the class chain:');
  for (const f of newAbsent) {
    console.log(`  PanelBridge.lua:${f.line}  ${f.receiverExpr} (${f.receiverType}) has no ${f.methodName}()`);
  }
  console.log('');
  console.log(`FAIL: ${newAbsent.length} newly-absent engine method call(s), not covered by the reviewed baseline. Either this is a real regression (fix PanelBridge.lua), or it's a call site worth the same review the rest of ${path.relative(ROOT, BASELINE_PATH)} got (add it there with a reason, in the right category) -- never add an entry just to make the gate pass. See scripts/engine-signatures.manifest.json for the source of truth, and scripts/gen-engine-signatures.mjs's header for what "definitely absent" does and does not prove.`);
  process.exit(1);
}

console.log('');
console.log(`PASS: no NEW definitively absent engine method calls (${baselined.length} previously-reviewed finding(s) accounted for by the baseline).`);
process.exit(0);
