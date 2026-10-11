// Builds store-ready zips for both browsers from the single source tree.
// Usage: node scripts/package.mjs            -> dist/canvas-video-saver-{chrome,firefox}-<version>.zip
//
// The unpacked source already loads in both browsers as-is (manifest.json has
// both background keys). This script only produces *clean* per-browser
// manifests so neither store shows warnings about the other browser's key:
//   chrome : drops background.scripts and browser_specific_settings
//   firefox: drops background.service_worker
// No dependencies; uses the system `zip` command if present.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'background.js', 'lib', 'icons',
  'popup.html', 'popup.css', 'popup.js',
  'options.html', 'options.js',
  'hls.html', 'hls.js', 'page.css',
];

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

const variants = {
  chrome(m) {
    delete m.background.scripts;
    delete m.browser_specific_settings;
    return m;
  },
  firefox(m) {
    delete m.background.service_worker;
    return m;
  },
};

const dist = join(root, 'dist');
for (const [name, transform] of Object.entries(variants)) {
  const out = join(dist, name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const f of FILES) cpSync(join(root, f), join(out, f), { recursive: true });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(transform(structuredClone(manifest)), null, 2) + '\n');

  const zipName = `canvas-video-saver-${name}-${manifest.version}.zip`;
  const zipPath = join(dist, zipName);
  if (existsSync(zipPath)) rmSync(zipPath);
  try {
    execFileSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: out, stdio: 'inherit' });
    console.log(`${name}: dist/${zipName}`);
  } catch {
    console.log(`${name}: dist/${name}/ (zip command not found - zip the folder contents manually)`);
  }
}
