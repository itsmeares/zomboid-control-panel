#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  stripLuaComments,
  resolveAllCallSites,
  SEED_GLOBALS,
  STATIC_CLASS_SEEDS,
} from './lib/engine-signature-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LUA_PATH = path.join(ROOT, 'integrations/panelbridge/PanelBridge/media/lua/server/PanelBridge.lua');
const MANIFEST_PATH = path.join(__dirname, 'engine-signatures.manifest.json');

const MIN_SEED_FINGERPRINT_COVERAGE = 0.7;
const MAX_SUPERCLASS_DEPTH = 25;

function inferJarBuildId(jarPath) {
  const manifestPath = path.resolve(path.dirname(jarPath), '..', 'steamapps', 'appmanifest_380870.acf');
  try {
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    return manifest.match(/"buildid"\s+"([^"]+)"/)?.[1] || null;
  } catch {
    return process.env.PZ_BUILD_ID?.trim() || null;
  }
}

function parseArgs(argv) {
  const args = { javap: null, jar: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--javap') args.javap = argv[++i];
    else if (argv[i] === '--jar') args.jar = argv[++i];
  }
  return args;
}

const cli = parseArgs(process.argv.slice(2));
const JAVAP_PATH =
  cli.javap ||
  process.env.PZ_JAVAP_PATH ||
  "javap";
const JAR_PATH =
  cli.jar ||
  process.env.PZ_JAR_PATH ||
  null;

if (!JAR_PATH) {
  console.error("projectzomboid.jar path required (pass --jar or set PZ_JAR_PATH)");
  process.exit(2);
}

if (!fs.existsSync(JAVAP_PATH)) {
  console.error(`javap not found at ${JAVAP_PATH} (pass --javap or set PZ_JAVAP_PATH)`);
  process.exit(2);
}
if (!fs.existsSync(JAR_PATH)) {
  console.error(`projectzomboid.jar not found at ${JAR_PATH} (pass --jar or set PZ_JAR_PATH)`);
  process.exit(2);
}


const javapCache = new Map();
let javapInvocations = 0;

function runJavap(className) {
  javapInvocations++;
  try {
    const out = execFileSync(JAVAP_PATH, ['-p', '-classpath', JAR_PATH, className], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out;
  } catch (err) {
    return null;
  }
}

function stripGenerics(typeText) {
  const idx = typeText.indexOf('<');
  return (idx === -1 ? typeText : typeText.slice(0, idx)).trim();
}

function splitTopLevelGeneric(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<') depth++;
    else if (c === '>') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((s) => s.trim()).filter(Boolean);
}

const COLLECTION_RETURN_RE =
  /^java\.util\.(List|ArrayList|LinkedList|Set|HashSet|LinkedHashSet|Collection)<([^<>]+)>$/;

function parseReturnType(rawReturnType) {
  const base = stripGenerics(rawReturnType);
  const m = COLLECTION_RETURN_RE.exec(rawReturnType.replace(/\s+/g, ''));
  let elementClass = null;
  if (m) {
    const inner = m[2];
    if (/^[\w$]+(\.[\w$]+)+$/.test(inner)) elementClass = inner;
  }
  const primitiveOrVoid = /^(void|boolean|byte|short|int|long|float|double|char)(\[\])*$/.test(base);
  return {
    returnClass: primitiveOrVoid || !base.includes('.') && !base.includes('$') ? null : base,
    elementClass,
  };
}

const MODIFIER_WORDS = new Set([
  'public', 'protected', 'private', 'static', 'final', 'abstract', 'synchronized', 'native',
  'transient', 'volatile', 'strictfp', 'default',
]);

function parseMemberLine(line) {
  let text = line.trim().replace(/;$/, '');
  if (!text.includes('(')) return null;
  const tokens = text.split(/\s+/);
  let idx = 0;
  while (idx < tokens.length && MODIFIER_WORDS.has(tokens[idx])) idx++;
  text = tokens.slice(idx).join(' ');
  if (text.startsWith('<')) {
    let depth = 0;
    let i = 0;
    for (; i < text.length; i++) {
      if (text[i] === '<') depth++;
      else if (text[i] === '>') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    text = text.slice(i).trim();
  }
  const parenIdx = text.indexOf('(');
  if (parenIdx === -1) return null;
  const beforeParen = text.slice(0, parenIdx).trim();
  const paramsText = text.slice(parenIdx + 1, text.lastIndexOf(')'));
  const nameMatch = /([A-Za-z_]\w*)\s*$/.exec(beforeParen);
  if (!nameMatch) return null;
  const methodName = nameMatch[1];
  const rawReturnType = beforeParen.slice(0, nameMatch.index).trim();
  if (!rawReturnType) return null;
  const { returnClass, elementClass } = parseReturnType(rawReturnType);
  const paramCount = paramsText.trim() === '' ? 0 : splitTopLevelGeneric(paramsText).length;
  return { methodName, returnClass, elementClass, rawReturnType, paramCount };
}

function parseJavapOutput(className, output) {
  const lines = output.split(/\r?\n/);
  let superclasses = [];
  let declLineFound = false;
  const methods = new Map();
  for (const line of lines) {
    if (!declLineFound && /\b(class|interface|enum)\s+[\w.$]+/.test(line) && line.includes(className)) {
      declLineFound = true;
      const extMatch = /\bextends\s+(.+?)(?=\s+implements\b|\s*\{?\s*$)/.exec(line);
      if (extMatch) {
        superclasses = splitTopLevelGeneric(extMatch[1]).map(stripGenerics).filter(Boolean);
      }
      const implMatch = /\bimplements\s+(.+?)\s*\{?\s*$/.exec(line);
      if (implMatch) {
        superclasses.push(...splitTopLevelGeneric(implMatch[1]).map(stripGenerics).filter(Boolean));
      }
      continue;
    }
    const parsed = parseMemberLine(line);
    if (!parsed) continue;
    const list = methods.get(parsed.methodName) || [];
    list.push({
      returns: parsed.rawReturnType,
      returnClass: parsed.returnClass,
      elementClass: parsed.elementClass,
      paramCount: parsed.paramCount,
    });
    methods.set(parsed.methodName, list);
  }
  return { superclasses, methods };
}

function loadClass(className, depth = 0) {
  if (javapCache.has(className)) return javapCache.get(className);
  if (depth > MAX_SUPERCLASS_DEPTH) {
    const entry = { exists: false };
    javapCache.set(className, entry);
    return entry;
  }
  const out = runJavap(className);
  if (out === null) {
    const entry = { exists: false };
    javapCache.set(className, entry);
    return entry;
  }
  const { superclasses, methods } = parseJavapOutput(className, out);
  const mergedMethods = new Map();
  for (const [name, sigs] of methods) mergedMethods.set(name, sigs.slice());
  const resolvedSuperclasses = [];
  for (const sup of superclasses) {
    const supInfo = loadClass(sup, depth + 1);
    resolvedSuperclasses.push(sup);
    if (supInfo.exists) {
      for (const [name, sigs] of supInfo.methods) {
        if (!mergedMethods.has(name)) mergedMethods.set(name, sigs);
        else mergedMethods.get(name).push(...sigs.filter((s) => !mergedMethods.get(name).some((e) => e.paramCount === s.paramCount && e.returns === s.returns)));
      }
    }
  }
  const entry = { exists: true, declaredSuperclasses: resolvedSuperclasses, methods: mergedMethods };
  javapCache.set(className, entry);
  return entry;
}

function classProvider(className, methodName) {
  const info = loadClass(className);
  if (!info.exists) return null;
  const sigs = info.methods.get(methodName);
  if (!sigs || sigs.length === 0) return { exists: false };
  return { exists: true, returnClass: sigs[0].returnClass, elementClass: sigs[0].elementClass };
}


function computeSeedFingerprint(cleanedSrc, seedFnName) {
  const varNames = new Set();
  const assignRe = new RegExp(`(?:local\\s+)?([A-Za-z_]\\w*)\\s*=\\s*${seedFnName}\\s*\\(`, 'g');
  let m;
  while ((m = assignRe.exec(cleanedSrc))) varNames.add(m[1]);

  const methodNames = new Set();
  for (const varName of varNames) {
    const directRe = new RegExp(`\\b${varName}\\s*:\\s*([A-Za-z_]\\w*)\\s*\\(`, 'g');
    while ((m = directRe.exec(cleanedSrc))) methodNames.add(m[1]);
    const helperRe = new RegExp(
      `PanelBridge\\.(?:invoke|hasMethod|safeCall|safeGet|tryGet)\\(\\s*${varName}\\s*,\\s*["']([A-Za-z_]\\w*)["']`,
      'g',
    );
    while ((m = helperRe.exec(cleanedSrc))) methodNames.add(m[1]);
  }
  return { varNames, methodNames };
}

function verifySeed(seedFnName, seedDef, cleanedSrc) {
  const { varNames, methodNames } = computeSeedFingerprint(cleanedSrc, seedFnName);
  if (methodNames.size === 0) {
    return { status: 'unused', varNames, methodNames, coverage: null };
  }
  const info = loadClass(seedDef.class);
  if (!info.exists) {
    return { status: 'class-not-found', varNames, methodNames, coverage: 0 };
  }
  const missing = [...methodNames].filter((n) => !info.methods.has(n));
  const coverage = (methodNames.size - missing.length) / methodNames.size;
  return {
    status: coverage >= MIN_SEED_FINGERPRINT_COVERAGE ? 'accepted' : 'rejected',
    varNames, methodNames, coverage, missing,
  };
}


const rawSrc = fs.readFileSync(LUA_PATH, 'utf8');
const cleanedSrc = stripLuaComments(rawSrc);

console.log(`javap:  ${JAVAP_PATH}`);
console.log(`jar:    ${JAR_PATH}`);
console.log(`source: ${path.relative(ROOT, LUA_PATH)}`);
console.log('');
console.log('=== seed verification (fingerprint coverage against the real jar) ===');
const seedReport = {};
const acceptedSeeds = {};
for (const [fnName, def] of Object.entries(SEED_GLOBALS)) {
  const result = verifySeed(fnName, def, cleanedSrc);
  seedReport[fnName] = result;
  const pct = result.coverage == null ? 'n/a' : `${Math.round(result.coverage * 100)}%`;
  console.log(
    `  ${result.status.padEnd(14)} ${fnName.padEnd(22)} -> ${def.class.padEnd(35)} coverage=${pct} (fingerprint: ${result.methodNames.size} methods from ${result.varNames.size} var name(s))`,
  );
  if (result.status === 'rejected') {
    console.log(`      missing on ${def.class}: ${result.missing.join(', ')}`);
  }
  if (result.status === 'accepted' || result.status === 'unused') {
    acceptedSeeds[fnName] = def;
  }
}
console.log('');
console.log('=== static-class-accessor seed verification (e.g. GameTime.getInstance()) ===');
const staticSeedReport = {};
const acceptedStaticSeeds = {};
for (const [className, fqn] of Object.entries(STATIC_CLASS_SEEDS)) {
  const varNames = new Set();
  const assignRe = new RegExp(`(?:local\\s+)?([A-Za-z_]\\w*)\\s*=\\s*${className}\\.\\w+\\s*\\(`, 'g');
  let am;
  while ((am = assignRe.exec(cleanedSrc))) varNames.add(am[1]);
  const methodNames = new Set();
  for (const varName of varNames) {
    const directRe = new RegExp(`\\b${varName}\\s*:\\s*([A-Za-z_]\\w*)\\s*\\(`, 'g');
    let mm;
    while ((mm = directRe.exec(cleanedSrc))) methodNames.add(mm[1]);
  }
  const info = loadClass(fqn);
  let status;
  let coverage = null;
  let missing = [];
  if (methodNames.size === 0) {
    status = 'unused';
  } else if (!info.exists) {
    status = 'class-not-found';
    coverage = 0;
  } else {
    missing = [...methodNames].filter((n) => !info.methods.has(n));
    coverage = (methodNames.size - missing.length) / methodNames.size;
    status = coverage >= MIN_SEED_FINGERPRINT_COVERAGE ? 'accepted' : 'rejected';
  }
  staticSeedReport[className] = { status, coverage, methodNames, missing };
  const pct = coverage == null ? 'n/a' : `${Math.round(coverage * 100)}%`;
  console.log(`  ${status.padEnd(14)} ${className.padEnd(22)} -> ${fqn.padEnd(35)} coverage=${pct} (fingerprint: ${methodNames.size} methods from ${varNames.size} var name(s))`);
  if (status === 'rejected') console.log(`      missing on ${fqn}: ${missing.join(', ')}`);
  if (status === 'accepted' || status === 'unused') acceptedStaticSeeds[className] = fqn;
}

const rejectedCount =
  Object.values(seedReport).filter((r) => r.status === 'rejected' || r.status === 'class-not-found').length +
  Object.values(staticSeedReport).filter((r) => r.status === 'rejected' || r.status === 'class-not-found').length;
if (rejectedCount > 0) {
  console.log(`\n${rejectedCount} seed(s) REJECTED (see above) -- calls through them will resolve as unknown, not guessed.`);
}

for (const key of Object.keys(SEED_GLOBALS)) {
  if (!(key in acceptedSeeds)) delete SEED_GLOBALS[key];
}
for (const key of Object.keys(STATIC_CLASS_SEEDS)) {
  if (!(key in acceptedStaticSeeds)) delete STATIC_CLASS_SEEDS[key];
}

const { callSites } = resolveAllCallSites(rawSrc, classProvider);

const touchedClasses = new Set();
for (const site of callSites) {
  if (site.receiverType) touchedClasses.add(site.receiverType);
}
for (const [className, info] of javapCache) {
  if (info.exists) touchedClasses.add(className);
}

const resolvedCount = callSites.filter((s) => s.resolved).length;
const absentFindings = callSites.filter((s) => s.resolved && s.methodInfo && s.methodInfo.exists === false);

console.log('');
console.log('=== call site resolution (using only accepted seeds) ===');
console.log(`  call sites found:      ${callSites.length}`);
console.log(`  receivers resolved:    ${resolvedCount}`);
console.log(`  skipped (unresolved):  ${callSites.length - resolvedCount}`);
console.log(`  ABSENT methods found:  ${absentFindings.length}`);
if (absentFindings.length > 0) {
  console.log('');
  console.log('  Definitively absent (javap confirms no such method anywhere in the class chain):');
  for (const f of absentFindings) {
    console.log(`    PanelBridge.lua:${f.line}  ${f.receiverExpr} (${f.receiverType}) has no ${f.methodName}()`);
  }
}

console.log('');
console.log(`javap invocations this run: ${javapInvocations}`);
console.log(`classes in manifest:        ${touchedClasses.size}`);


const manifestClasses = {};
for (const className of [...touchedClasses].sort()) {
  const info = javapCache.get(className);
  if (!info || !info.exists) continue;
  const methods = {};
  for (const [name, sigs] of info.methods) {
    methods[name] = sigs.map((s) => ({
      returns: s.returns,
      returnClass: s.returnClass,
      elementClass: s.elementClass,
      paramCount: s.paramCount,
    }));
  }
  manifestClasses[className] = { declaredSuperclasses: info.declaredSuperclasses, methods };
}

let javapVersion = 'unknown';
try {
  javapVersion = execFileSync(JAVAP_PATH, ['-version'], { encoding: 'utf8' }).trim();
} catch {
  // best-effort only
}

const manifest = {
  generatedAt: new Date().toISOString(),
  generatorNote: 'Run `node scripts/gen-engine-signatures.mjs` to regenerate after PanelBridge.lua or the game jar changes.',
  javapVersion,
  jarBasename: path.basename(JAR_PATH),
  jarBuildId: inferJarBuildId(JAR_PATH),
  jarFileSha256: crypto.createHash('sha256').update(fs.readFileSync(JAR_PATH)).digest('hex'),
  sourceFile: path.relative(ROOT, LUA_PATH).replace(/\\/g, '/'),
  sourceFileSha256: crypto.createHash('sha256').update(rawSrc).digest('hex'),
  seedGlobals: acceptedSeeds,
  staticClassSeeds: acceptedStaticSeeds,
  rejectedSeeds: Object.fromEntries(
    [...Object.entries(seedReport), ...Object.entries(staticSeedReport)]
      .filter(([, r]) => r.status === 'rejected' || r.status === 'class-not-found')
      .map(([name, r]) => [name, { status: r.status, coverage: r.coverage, missing: r.missing }]),
  ),
  classes: manifestClasses,
};

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
console.log('');
console.log(`wrote ${path.relative(ROOT, MANIFEST_PATH)}`);
