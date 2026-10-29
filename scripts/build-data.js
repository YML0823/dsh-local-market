#!/usr/bin/env node
/**
 * 从社区目录生成离线快照。
 * 默认读取 ../vendor/plugins.json；不存在时自动从上游拉取。
 */
const fs = require('fs');
const path = require('path');
const { normalizeCatalog } = require('../lib/catalog.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'data');
const SOURCE = process.env.CATALOG_SOURCE || path.join(ROOT, '..', 'vendor', 'plugins.json');
const LIVE_URL = process.env.CATALOG_LIVE_URL || 'https://awesome-dsh-plugin.com/plugins.json';

async function readSource() {
  if (fs.existsSync(SOURCE)) {
    console.log(`[data] reading ${SOURCE}`);
    return JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  }
  console.log(`[data] fetching ${LIVE_URL}`);
  const response = await fetch(LIVE_URL, {
    signal: AbortSignal.timeout(60000),
    headers: { Accept: 'application/json', 'User-Agent': 'dsh-local-market/1.0' },
  });
  if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
  return response.json();
}

(async () => {
  const raw = await readSource();
  const catalog = normalizeCatalog(raw);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'plugins.json'),
    JSON.stringify({ stats: catalog.stats, categories: catalog.categories, plugins: catalog.plugins }),
    'utf8',
  );
  fs.writeFileSync(path.join(OUT, 'featured.json'), JSON.stringify(catalog.featured), 'utf8');
  fs.writeFileSync(
    path.join(OUT, 'meta.json'),
    JSON.stringify(
      {
        source: catalog.source,
        catalogUpdated: catalog.stats.updated,
        generatedAt: new Date().toISOString(),
        ...catalog.stats,
      },
      null,
      2,
    ),
    'utf8',
  );
  const size = fs.statSync(path.join(OUT, 'plugins.json')).size;
  console.log(`[data] ${catalog.plugins.length} plugins, ${catalog.stats.withScreenshots} with screenshots, ${(size / 1024 / 1024).toFixed(1)} MB`);
})().catch((error) => {
  console.error('[data] failed:', error);
  process.exitCode = 1;
});
