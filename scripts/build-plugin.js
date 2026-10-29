#!/usr/bin/env node
/** 构建 DSH 本地插件包：复制 UI、生成 tarball。 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugin');
const PUBLIC = path.join(ROOT, 'public');
const UI = path.join(PLUGIN, 'ui');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'package');

fs.rmSync(UI, { recursive: true, force: true });
fs.cpSync(PUBLIC, UI, { recursive: true });
fs.rmSync(path.join(PLUGIN, 'lib'), { recursive: true, force: true });
fs.mkdirSync(path.join(PLUGIN, 'lib'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'lib', 'catalog.js'), path.join(PLUGIN, 'lib', 'catalog.cjs'));
console.log(`[plugin] copied UI and catalog module -> ${PLUGIN}`);

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'package.json']) {
  fs.copyFileSync(path.join(PLUGIN, file), path.join(STAGE, file));
}
fs.mkdirSync(path.join(STAGE, 'lib'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'lib', 'catalog.js'), path.join(STAGE, 'lib', 'catalog.cjs'));
fs.cpSync(UI, path.join(STAGE, 'ui'), { recursive: true });

const tarball = path.join(DIST, 'dsh-local-market-1.0.1.tgz');
execFileSync('tar', ['-czf', tarball, '-C', DIST, 'package'], { stdio: 'inherit' });
fs.rmSync(STAGE, { recursive: true, force: true });
console.log(`[plugin] tarball -> ${tarball} (${(fs.statSync(tarball).size / 1024 / 1024).toFixed(1)} MB)`);
