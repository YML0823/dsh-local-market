'use strict';

/**
 * Shared catalog normalization for the standalone app and the DSH host plugin.
 * The upstream feed uses a richer shape than the UI; this keeps both surfaces
 * reading one shape and lets the live refresh reuse the bundled snapshot shape.
 */

const CATEGORY_STYLE = {
  agi: { icon: '✦', color: '#a78bfa' },
  ui: { icon: '◫', color: '#5eead4' },
  usage: { icon: '◔', color: '#fbbf24' },
  theme: { icon: '◐', color: '#f472b6' },
  model: { icon: '⬡', color: '#60a5fa' },
  identity: { icon: '◉', color: '#c084fc' },
  session: { icon: '☰', color: '#34d399' },
  memory: { icon: '❖', color: '#818cf8' },
  tools: { icon: '⚒', color: '#fbbf24' },
  wsl: { icon: '⌘', color: '#38bdf8' },
  browser: { icon: '◎', color: '#2dd4bf' },
  vision: { icon: '◉', color: '#fb7185' },
  voice: { icon: '♪', color: '#f59e0b' },
  docs: { icon: '▤', color: '#a3e635' },
  skill: { icon: '✧', color: '#e879f9' },
  workflow: { icon: '⇢', color: '#22d3ee' },
  git: { icon: '⑂', color: '#fb923c' },
  notify: { icon: '◈', color: '#facc15' },
  dev: { icon: '⌬', color: '#4ade80' },
  security: { icon: '⛨', color: '#f87171' },
  remote: { icon: '⇱', color: '#38bdf8' },
  market: { icon: '▦', color: '#60a5fa' },
  fun: { icon: '✺', color: '#f472b6' },
};

const FEATURED = [
  {
    id: 'Nwflower/dsh-claude-style',
    kicker: '界面主题',
    title: '把 DSH 换成 Claude 的质感',
    blurb: '象牙白与暖黑双画布、陶烬橙强调色，连交互细节一起复刻。',
    image: 'assets/hero/claude.png',
    heroImage: 'assets/hero/claude-hero.png',
    accent: '#f59e0b',
  },
  {
    id: 'dsh-market/dsh-market',
    kicker: '社区市场',
    title: '在 DSH 里逛插件，像逛应用商店',
    blurb: '分类、搜索、一键安装，主题与配置备份也一并收进一个入口。',
    image: 'assets/hero/dsh-market.png',
    accent: '#60a5fa',
  },
  {
    id: 'yyh-001/dsh-meme',
    kicker: '聊天氛围',
    title: '斗图这件事，Agent 也得会',
    blurb: '表情包选择器、情绪自动发图、自定义表情包，聊天气氛直接拉满。',
    image: 'assets/hero/meme.png',
    accent: '#f472b6',
  },
  {
    id: 'omdsh-dev/dsh-genui',
    kicker: '生成式界面',
    title: '让 AI 的回复，变成能点的界面',
    blurb: '图表、表单、测验和 3D 场景直接在对话里渲染，操作还能回传。',
    image: 'assets/hero/genui.jpg',
    accent: '#5eead4',
  },
  {
    id: 'liustack/modlens',
    kicker: '视觉外挂',
    title: '给纯文本模型，装上一双眼睛',
    blurb: '粘贴截图，直接输出 OCR、版面与语义证据。DeepSeek 也能看图干活。',
    image: 'assets/hero/modlens.jpg',
    accent: '#fb7185',
  },
];

function parseInstall(install) {
  let spec = String(install || '').replace(/^dsh plugin --profile\s+\S+\s+add\s+/, '').trim();
  if ((spec.startsWith('"') && spec.endsWith('"')) || (spec.startsWith("'") && spec.endsWith("'"))) {
    spec = spec.slice(1, -1);
  }
  let kind = 'npm';
  if (/^github:/i.test(spec)) kind = 'github';
  else if (/^https?:\/\//i.test(spec)) kind = 'url';
  return { spec, kind };
}

function cleanText(value, max = 420) {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function makeId(plugin) {
  const page = String(plugin.page || '').replace(/^https?:\/\/[^/]+\/p\//, '').replace(/\/+$/, '');
  if (page) return page;
  return `${plugin.owner}/${plugin.name}`.replace(/[^a-zA-Z0-9_./-]/g, '-');
}

function makeDisplay(name) {
  const base = String(name || '').split('#')[0];
  return base.replace(/^dsh[-_]?/i, '') || base;
}

function normalizeCatalog(raw) {
  const sourcePlugins = Array.isArray(raw?.plugins) ? raw.plugins : [];
  const seen = new Set();
  const items = [];

  for (const plugin of sourcePlugins) {
    if (!plugin || !plugin.name || !plugin.install) continue;
    const id = makeId(plugin);
    if (seen.has(id)) continue;
    seen.add(id);
    const { spec, kind } = parseInstall(plugin.install);
    const shots = Array.isArray(plugin.screenshots) ? plugin.screenshots.filter(Boolean).slice(0, 8) : [];
    const caps = Array.isArray(plugin.capabilities) ? plugin.capabilities : [];
    items.push({
      id,
      name: plugin.name,
      owner: plugin.owner || '',
      display: makeDisplay(plugin.name),
      url: plugin.url || '',
      category: plugin.category || 'tools',
      desc: cleanText(plugin.description?.zh),
      descEn: cleanText(plugin.description?.en, 320),
      stars: Number.isFinite(plugin.stars) ? plugin.stars : null,
      downloads: Number.isFinite(plugin.downloads) ? plugin.downloads : null,
      version: plugin.version || null,
      npm: plugin.npm || null,
      spec,
      kind,
      added: plugin.added || null,
      shots,
      icon: plugin.icon || null,
      caps,
      redLines: Array.isArray(plugin.capabilityRedLines) ? plugin.capabilityRedLines.slice(0, 4) : [],
      page: plugin.page || '',
    });
  }

  items.sort((a, b) => (b.stars || 0) - (a.stars || 0) || String(b.added || '').localeCompare(String(a.added || '')));

  const categories = Object.entries(raw?.categories || {}).map(([id, category]) => {
    const style = CATEGORY_STYLE[id] || { icon: '◇', color: '#94a3b8' };
    return {
      id,
      name: category.zh || category.en || id,
      nameEn: category.en || id,
      count: items.filter((item) => item.category === id).length,
      ...style,
    };
  });

  for (const feature of FEATURED) {
    const hit = items.find((item) => item.id === feature.id);
    if (hit) {
      hit.featured = true;
      hit.featuredTitle = feature.title;
    }
  }

  const updated = raw?.updated || new Date().toISOString().slice(0, 10);
  const stats = {
    total: items.length,
    withScreenshots: items.filter((item) => item.shots.length).length,
    categories: categories.length,
    totalStars: items.reduce((sum, item) => sum + (item.stars || 0), 0),
    totalDownloads: items.reduce((sum, item) => sum + (item.downloads || 0), 0),
    updated,
  };

  return {
    stats,
    categories,
    plugins: items,
    featured: FEATURED,
    source: raw?.source || 'https://awesome-dsh-plugin.com/plugins.json',
  };
}

module.exports = { normalizeCatalog, FEATURED, CATEGORY_STYLE };
