// After `vite build`: the app's own bundle must not contain the slicer engine. The engine is AGPL-3.0 and is served
// beside the page, started by URL; the app only sends it messages. The engine's host carries a canary string (its
// manifest names it) so a client can prove that no engine code was bundled into it. Run by `npm run build`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const slicer = JSON.parse(readFileSync('public/slicer/slicer.json', 'utf8'));
const manifest = readFileSync(join('public/slicer', slicer.engine.base, 'manifest.json'), 'utf8');
const canary = /"canary"\s*:\s*"([^"]+)"/.exec(manifest)?.[1];
if (!canary) {
  console.error('check-bundle: the engine manifest names no canary; cannot check the bundle.');
  process.exit(1);
}

const offenders = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (readFileSync(p).includes(canary)) offenders.push(p);
  }
};
walk('dist/assets');
for (const f of ['dist/index.html']) if (readFileSync(f).includes(canary)) offenders.push(f);

if (offenders.length) {
  console.error(`check-bundle: engine code found in the app bundle (canary ${canary}):\n  ${offenders.join('\n  ')}`);
  process.exit(1);
}
console.log('check-bundle: no engine code in dist/assets (canary absent).');
