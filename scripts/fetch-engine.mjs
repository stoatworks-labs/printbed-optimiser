#!/usr/bin/env node
// Fetches the slicer engine and its profile set from the pinned Muon3D Slicer Engine release, checks each
// download against the release's own SHA-256 sums, and copies what the app serves into public/slicer/:
//
//   public/slicer/slicer.json                    where the app finds everything below (written last)
//   public/slicer/engine/<version>/              the host, the single-threaded engine, LICENSE, NOTICE, SOURCE.md
//   public/slicer/profiles/<set>/                the profile index, one gzip bundle per vendor, SOURCE.json, LICENSE
//
// The engine is OrcaSlicer's libslic3r compiled to WebAssembly (AGPL-3.0-only). This app never imports or bundles
// it: the page starts the host as a Web Worker by URL and talks to it only with messages. Downloads are cached in
// .cache/ so a rebuild does not fetch again. Idempotent: does nothing when public/slicer/ already holds this pin.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PIN = {
  version: '0.6.1',
  repository: 'https://github.com/Muon-3D/muon3d-slicer-engine',
  assets: {
    engine: { file: 'muon3d-slicer-engine-0.6.1.tgz', sha256: '1c6b676e0405c387fb9742568f7b142b5cb2ac3942f05022ceb9769d87cac573' },
    profiles: { file: 'muon3d-slicer-profiles-0.6.1.tgz', sha256: '8c349e2fd4f2318ce373e7a657de22047e303b900ed51a3a0ed3ba6fc6ee9f56' },
  },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, '.cache', 'muon3d');
const outDir = path.join(root, 'public', 'slicer');
const pointer = path.join(outDir, 'slicer.json');

if (fs.existsSync(pointer)) {
  try {
    if (JSON.parse(fs.readFileSync(pointer, 'utf8')).engine?.version === PIN.version) process.exit(0);
  } catch {
    // fall through and rebuild
  }
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function fetchAsset({ file, sha256: expected }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, file);
  if (fs.existsSync(target) && sha256(target) === expected) return target;
  const url = `${PIN.repository}/releases/download/v${PIN.version}/${file}`;
  console.log(`fetch-engine: downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const tmp = `${target}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  const got = sha256(tmp);
  if (got !== expected) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${file}: sha256 ${got}, expected ${expected}`);
  }
  fs.renameSync(tmp, target);
  return target;
}

function extract(tgz) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printbed-engine-'));
  execFileSync('tar', ['-xzf', tgz, '-C', dir]);
  const [top] = fs.readdirSync(dir);
  return { dir, top: path.join(dir, top) };
}

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

const engineTgz = await fetchAsset(PIN.assets.engine);
const profilesTgz = await fetchAsset(PIN.assets.profiles);

fs.rmSync(outDir, { recursive: true, force: true });

// ---- The engine: the host, its chunks, the single-threaded engine and the notices --------------------------
const engine = extract(engineTgz);
const manifest = JSON.parse(fs.readFileSync(path.join(engine.top, 'manifest.json'), 'utf8'));
const engineOut = path.join(outDir, 'engine', manifest.version);
const keep = new Set(['manifest.json', 'LICENSE', 'NOTICE', 'SOURCE.md', 'THIRD-PARTY-NOTICES.md', 'engine-st.mjs', 'engine-st.wasm', manifest.host.file]);
for (const chunk of manifest.host.chunks ?? []) keep.add(chunk.file);
for (const name of fs.readdirSync(engine.top)) {
  // Precompressed copies (.br, .gz) are for servers that negotiate them; the multithreaded builds need a
  // cross-origin isolated page, and the app runs a pool of single-threaded hosts instead.
  if (keep.has(name) || (name.startsWith('host-') && name.endsWith('.js'))) copy(path.join(engine.top, name), path.join(engineOut, name));
}
fs.rmSync(engine.dir, { recursive: true, force: true });

// ---- The profile set: index, vendor bundles, source -- no bed models or printer pictures ------------------
const profiles = extract(profilesTgz);
const setsDir = path.join(profiles.top, 'profiles');
const set = fs.readdirSync(setsDir).find((d) => d !== 'assets');
const setIn = path.join(setsDir, set);
const setOut = path.join(outDir, 'profiles', set);
const indexFile = fs.readdirSync(setIn).find((f) => /^index\.[0-9a-f]+\.json$/.test(f));
copy(path.join(setIn, indexFile), path.join(setOut, indexFile));
copy(path.join(setIn, 'SOURCE.json'), path.join(setOut, 'SOURCE.json'));
copy(path.join(profiles.top, 'LICENSE'), path.join(setOut, 'LICENSE'));
for (const name of fs.readdirSync(path.join(setIn, 'vendors'))) copy(path.join(setIn, 'vendors', name), path.join(setOut, 'vendors', name));
fs.rmSync(profiles.dir, { recursive: true, force: true });

const index = JSON.parse(fs.readFileSync(path.join(setOut, indexFile), 'utf8'));
if (index.engine?.orca?.commit !== manifest.orca.commit) {
  throw new Error(`profile set ${set} was built for OrcaSlicer ${index.engine?.orca?.commit}, the engine is ${manifest.orca.commit}`);
}

fs.writeFileSync(
  pointer,
  JSON.stringify(
    {
      engine: {
        version: manifest.version,
        base: `engine/${manifest.version}/`,
        host: manifest.host.file,
        license: manifest.license,
        orca: { version: manifest.orca.version, commit: manifest.orca.commit },
        source: manifest.source.url,
        sourceTag: manifest.source.tag,
      },
      profiles: { set, index: `profiles/${set}/${indexFile}` },
    },
    null,
    2,
  ) + '\n',
);
console.log(`fetch-engine: engine ${manifest.version} (OrcaSlicer ${manifest.orca.version}) and profile set ${set} in public/slicer/`);
