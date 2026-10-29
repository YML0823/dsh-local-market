/* DSH Market — 前端应用 */
(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const CAP_LABELS = {
    'fs-read': '读取文件',
    'fs-write': '写入文件',
    network: '访问网络',
    shell: '执行命令',
    env: '读取环境变量',
    llm: '调用模型',
    'dynamic-code': '动态代码',
    'host-runtime': '宿主运行时',
  };
  const KIND_LABELS = { npm: 'npm', github: 'GitHub', url: 'Release' };
  const SORT_LABELS = { recommended: '推荐排序', stars: 'Star 最多', downloads: '下载最多', newest: '最近收录', name: '名称 A → Z' };
  const FAV_KEY = 'dsh-market:favorites:v1';
  const INSTALLED_KEY = 'dsh-market:installed:v1';
  const RECENT_KEY = 'dsh-market:recent:v1';
  const PROFILE_KEY = 'dsh-market:profile:v1';

  const state = {
    data: null,
    byId: new Map(),
    categories: [],
    catById: new Map(),
    featured: [],
    config: null,
    view: 'discover',
    category: 'all',
    filter: 'all',
    sort: 'recommended',
    query: '',
    layout: 'grid',
    page: 1,
    pageSize: 36,
    favorites: new Set(),
    installed: new Map(),
    heroIndex: 0,
    heroTimer: null,
    detailId: null,
    lightbox: { images: [], index: 0, title: '' },
    installJob: null,
    installSource: null,
    live: false,
    liveError: null,
    refreshedAt: null,
    catalogApi: false,
    installedApi: false,
    installedNames: new Set(),
    installedSpecs: [],
    installedProfile: null,
    installedSignature: '',
    syncBusy: false,
    isMobileNav: false,
  };

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalize(value) {
    return String(value ?? '').toLowerCase().normalize('NFKC');
  }

  function formatCount(value) {
    const number = Number(value) || 0;
    if (number >= 100000000) return `${(number / 100000000).toFixed(1).replace(/\.0$/, '')}亿`;
    if (number >= 10000) return `${(number / 10000).toFixed(1).replace(/\.0$/, '')}万`;
    if (number >= 1000) return `${(number / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return new Intl.NumberFormat('zh-CN').format(number);
  }

  function formatFull(value) {
    return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
  }

  function formatDate(value) {
    if (!value) return '—';
    return String(value).slice(0, 10).replace(/-/g, '.');
  }

  function shortName(plugin) {
    if (!plugin) return '';
    if (plugin.name.includes('#')) {
      const sub = plugin.name.split('#').slice(1).join('#');
      return sub.split('/').filter(Boolean).pop() || plugin.name.split('#')[0];
    }
    return plugin.name;
  }

  function categoryOf(plugin) {
    return state.catById.get(plugin.category) || { id: plugin.category, name: plugin.category, color: '#94a3b8', icon: '◇' };
  }

  function imageUrl(url) {
    return `${appUrl('api/image')}?u=${encodeURIComponent(url)}`;
  }

  function appUrl(pathname) {
    return new URL(pathname, document.baseURI).href;
  }

  function toast(message, type = 'ok') {
    const stack = $('#toastStack');
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'error' : ''}`;
    el.innerHTML = `<span class="toast-icon">${type === 'error' ? '!' : '✓'}</span><span>${esc(message)}</span>`;
    stack.appendChild(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 240);
    }, 2800);
  }

  async function copyText(text, message = '已复制到剪贴板') {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch (_) {}
      area.remove();
    }
    toast(message);
  }

  function saveFavorites() {
    localStorage.setItem(FAV_KEY, JSON.stringify([...state.favorites]));
    updateNavCounts();
  }

  function saveInstalled() {
    localStorage.setItem(INSTALLED_KEY, JSON.stringify([...state.installed.entries()]));
    updateNavCounts();
  }

  function loadStored() {
    try {
      const favorites = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
      if (Array.isArray(favorites)) state.favorites = new Set(favorites);
    } catch (_) {}
    try {
      const installed = JSON.parse(localStorage.getItem(INSTALLED_KEY) || '[]');
      if (Array.isArray(installed)) state.installed = new Map(installed);
    } catch (_) {}
  }

  function pluginRepository(plugin) {
    const match = String(plugin.url || '').match(/github\.com\/([^/]+)\/([^/#?]+)/i);
    return match ? `${match[1]}/${match[2]}`.toLowerCase() : '';
  }

  function installedCandidates(plugin) {
    const candidates = new Set();
    if (plugin.npm) candidates.add(String(plugin.npm).toLowerCase());
    const rawName = String(plugin.name || '');
    const [base, sub] = rawName.split('#');
    if (base) candidates.add(base.toLowerCase());
    if (sub) {
      const last = sub.split('/').filter(Boolean).pop();
      if (last) candidates.add(last.toLowerCase());
    }
    if (String(plugin.spec || '').startsWith('github:')) {
      const repo = String(plugin.spec).slice(7).split('#')[0];
      const name = repo.split('/')[1];
      if (name) candidates.add(name.toLowerCase());
    }
    const repo = pluginRepository(plugin);
    if (repo) {
      const name = repo.split('/')[1];
      if (name) candidates.add(name);
    }
    return [...candidates].filter(Boolean);
  }

  function matchesInstalled(plugin) {
    for (const candidate of installedCandidates(plugin)) {
      if (state.installedNames.has(candidate)) return true;
    }
    const repo = pluginRepository(plugin);
    if (repo) {
      for (const spec of state.installedSpecs) {
        if (spec.includes(repo)) return true;
      }
    }
    return false;
  }

  function isInstalled(id) {
    const plugin = state.byId.get(id);
    if (state.installedApi && plugin) {
      if (matchesInstalled(plugin)) return true;
      const local = state.installed.get(id);
      return Boolean(local && Date.now() - Number(local.at || 0) < 120000);
    }
    return state.installed.has(id);
  }

  async function loadInstalled() {
    try {
      const response = await fetch(appUrl('api/installed'), { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const names = Array.isArray(data.names) ? data.names.map((name) => String(name).toLowerCase()) : [];
      const specs = Array.isArray(data.specs) ? data.specs.map((spec) => String(spec).toLowerCase()) : [];
      const signature = `${data.profile || ''}|${names.join(',')}|${specs.join(',')}`;
      const changed = signature !== state.installedSignature;
      state.installedApi = true;
      state.installedProfile = data.profile || null;
      state.installedNames = new Set(names);
      state.installedSpecs = specs;
      state.installedSignature = signature;
      if (changed) {
        updateNavCounts();
        if (state.view === 'installed') renderResults();
      }
      return changed;
    } catch (_) {
      state.installedApi = false;
      return false;
    }
  }

  async function refreshInstalled() {
    if (document.hidden) return;
    await loadInstalled();
  }

  function addRecent(id) {
    try {
      const recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((item) => item !== id);
      recent.unshift(id);
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 8)));
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------
  async function loadCatalog(force = false) {
    let payload = null;
    let apiOk = false;
    try {
      const response = await fetch(appUrl(`api/catalog${force ? '?refresh=1' : ''}`), {
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        payload = await response.json();
        apiOk = Array.isArray(payload.plugins);
      }
    } catch (_) {}
    if (!payload || !Array.isArray(payload.plugins)) {
      const response = await fetch('data/plugins.json', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`目录加载失败（HTTP ${response.status}）`);
      payload = await response.json();
      payload.live = false;
      apiOk = false;
    }
    state.catalogApi = apiOk;
    state.data = payload;
    state.live = Boolean(payload.live);
    state.liveError = payload.liveError || null;
    state.refreshedAt = payload.refreshedAt || null;
    state.categories = payload.categories || [];
    state.catById = new Map(state.categories.map((cat) => [cat.id, cat]));
    state.plugins = payload.plugins || [];
    state.byId = new Map(state.plugins.map((plugin) => [plugin.id, plugin]));
    for (const plugin of state.plugins) {
      const category = categoryOf(plugin);
      const caps = (plugin.caps || []).map((cap) => CAP_LABELS[cap] || cap).join(' ');
      plugin._short = shortName(plugin);
      plugin._hay = normalize([
        plugin.name,
        plugin._short,
        plugin.owner,
        plugin.desc,
        plugin.descEn,
        category.name,
        plugin.category,
        caps,
      ].join(' \n '));
      plugin._cat = category;
    }
    if (Array.isArray(payload.featured) && payload.featured.length) {
      state.featured = payload.featured;
    } else {
      try {
        const featuredResponse = await fetch('data/featured.json');
        if (featuredResponse.ok) state.featured = await featuredResponse.json();
      } catch (_) {}
    }
    if (!state.featured.length) {
      state.featured = state.plugins.slice(0, 5).map((plugin) => ({
        id: plugin.id,
        kicker: categoryOf(plugin).name,
        title: plugin._short,
        blurb: plugin.desc,
        image: plugin.shots?.[0] ? imageUrl(plugin.shots[0]) : '',
        accent: categoryOf(plugin).color,
      }));
    }
  }

  async function loadConfig() {
    try {
      const response = await fetch(appUrl('api/config'), { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.config = await response.json();
    } catch (error) {
      state.config = {
        profiles: [{ name: 'web', label: 'web', managed: false, exists: true }],
        defaultProfile: 'web',
        dshVersion: null,
        error: error.message,
      };
    }
    renderHostCard();
  }

  function renderHostCard() {
    const config = state.config;
    const profile = config?.profiles?.find((item) => item.name === config.defaultProfile) || config?.profiles?.[0];
    $('#hostProfile').textContent = profile ? profile.name : '未检测到 profile';
    $('#hostProfile').title = profile ? `${profile.label || profile.name}${config?.dshVersion ? ` · DSH ${config.dshVersion}` : ''}` : '';
    $('.host-dot').classList.toggle('off', !config || Boolean(config.error));
  }

  // ---------------------------------------------------------------------------
  // Category / nav rendering
  // ---------------------------------------------------------------------------
  function renderCategories() {
    const root = $('#categoryList');
    root.innerHTML = state.categories.map((cat) => `
      <button class="cat-item ${state.category === cat.id ? 'active' : ''}" data-category="${esc(cat.id)}" style="--cat:${esc(cat.color)}">
        <span class="cat-dot"></span>
        <span class="cat-name">${esc(cat.name)}</span>
        <span class="cat-count">${cat.count}</span>
      </button>
    `).join('');
  }

  function updateNavCounts() {
    const total = state.plugins?.length || state.data?.stats?.total || 0;
    const shots = state.plugins?.filter((plugin) => plugin.shots?.length).length || state.data?.stats?.withScreenshots || 0;
    $('#navTotal').textContent = formatCount(total);
    $('#navShots').textContent = formatCount(shots);
    $('#navFavorites').textContent = state.favorites.size;
    const installedCount = (state.plugins || []).filter((plugin) => isInstalled(plugin.id)).length;
    $('#navInstalled').textContent = installedCount;
    $('#statTotal').textContent = formatFull(total);
    const heroCount = $('#heroCount');
    if (heroCount) heroCount.textContent = formatFull(total);
    $('#statShots').textContent = formatFull(shots);
    $('#statCategories').textContent = state.categories.length || 23;
    if (state.data?.stats?.updated) {
      const [year, month, day] = String(state.data.stats.updated).split('-');
      $('#statUpdated').textContent = `${month}.${day}`;
      $('#heroUpdated').textContent = `${year}.${month}`;
    }
  }

  function setActiveNav() {
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === state.view));
    $$('.cat-item').forEach((item) => item.classList.toggle('active', item.dataset.category === state.category));
  }

  // ---------------------------------------------------------------------------
  // Search and filtering
  // ---------------------------------------------------------------------------
  function searchScore(plugin, query) {
    if (!query) return 0;
    const tokens = normalize(query).split(/\s+/).filter(Boolean);
    if (!tokens.length) return 0;
    let score = 0;
    for (const token of tokens) {
      if (!plugin._hay.includes(token)) return 0;
      if (normalize(plugin.name) === token) score += 900;
      else if (normalize(plugin.name).startsWith(token)) score += 420;
      else if (normalize(plugin.name).includes(token)) score += 260;
      if (normalize(plugin._short).includes(token)) score += 140;
      if (normalize(plugin.owner).includes(token)) score += 120;
      if (normalize(plugin.desc).includes(token)) score += 70;
      if (normalize(plugin.descEn).includes(token)) score += 28;
      if (normalize(plugin.category).includes(token)) score += 45;
      if ((plugin.caps || []).some((cap) => normalize(cap).includes(token))) score += 40;
    }
    return score;
  }

  function getFiltered() {
    const query = state.query.trim();
    let list = state.plugins;

    if (state.view === 'screenshots') list = list.filter((plugin) => plugin.shots?.length);
    if (state.view === 'favorites') list = list.filter((plugin) => state.favorites.has(plugin.id));
    if (state.view === 'installed') list = list.filter((plugin) => isInstalled(plugin.id));

    if (state.category !== 'all') list = list.filter((plugin) => plugin.category === state.category);

    if (state.filter === 'shots') list = list.filter((plugin) => plugin.shots?.length);
    if (state.filter === 'npm') list = list.filter((plugin) => plugin.kind === 'npm');
    if (state.filter === 'github') list = list.filter((plugin) => plugin.kind === 'github');
    if (state.filter === 'installed') list = list.filter((plugin) => isInstalled(plugin.id));

    if (query) {
      const scored = [];
      for (const plugin of list) {
        const score = searchScore(plugin, query);
        if (score > 0) scored.push({ plugin, score });
      }
      scored.sort((a, b) => b.score - a.score || (b.plugin.stars || 0) - (a.plugin.stars || 0));
      list = scored.map((item) => item.plugin);
      if (state.sort === 'recommended') return list;
      // Other sorts still filter by query, then sort below.
      list = [...list];
    } else {
      list = [...list];
    }

    const sort = state.sort;
    if (sort === 'stars') list.sort((a, b) => (b.stars || 0) - (a.stars || 0) || (b.downloads || 0) - (a.downloads || 0));
    else if (sort === 'downloads') list.sort((a, b) => (b.downloads || 0) - (a.downloads || 0) || (b.stars || 0) - (a.stars || 0));
    else if (sort === 'newest') list.sort((a, b) => String(b.added || '').localeCompare(String(a.added || '')) || (b.stars || 0) - (a.stars || 0));
    else if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    else {
      list.sort((a, b) => {
        if (Boolean(b.featured) !== Boolean(a.featured)) return Boolean(b.featured) ? 1 : -1;
        const starDelta = (b.stars || 0) - (a.stars || 0);
        if (starDelta) return starDelta;
        const downloadDelta = (b.downloads || 0) - (a.downloads || 0);
        if (downloadDelta) return downloadDelta;
        return String(b.added || '').localeCompare(String(a.added || ''));
      });
    }
    return list;
  }

  function resetPaging() {
    state.page = 1;
  }

  function clearAllFilters() {
    state.view = 'discover';
    state.category = 'all';
    state.filter = 'all';
    state.query = '';
    state.sort = 'recommended';
    $('#searchInput').value = '';
    $('#searchWrap .searchbox').classList.remove('has-value');
    $('#sortSelect').value = 'recommended';
    setActiveNav();
    renderCategories();
    resetPaging();
    renderResults();
    closeSearchPop();
  }

  // ---------------------------------------------------------------------------
  // Cards
  // ---------------------------------------------------------------------------
  function coverMarkup(plugin, className = '') {
    const cat = plugin._cat || categoryOf(plugin);
    const first = plugin.shots?.[0];
    const fallback = `
      <div class="cover-fallback" style="--cat:${esc(cat.color)}">
        <div class="cover-rings"></div>
        <span class="cover-glyph">${esc(cat.icon)}</span>
        <span class="cover-word">${esc(plugin.owner)} / ${esc(plugin._short || plugin.name)}</span>
      </div>`;
    if (!first) return `<div class="card-cover ${className}">${fallback}</div>`;
    return `
      <div class="card-cover ${className}">
        ${fallback}
        <img src="${esc(imageUrl(first))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">
      </div>`;
  }

  function badgeMarkup(plugin) {
    const cat = plugin._cat || categoryOf(plugin);
    const kind = KIND_LABELS[plugin.kind] || plugin.kind;
    return `<span class="card-badge" style="color:${esc(cat.color)}">${esc(cat.icon)} ${esc(cat.name)}</span><span class="card-badge">${esc(kind)}</span>`;
  }

  function cardMarkup(plugin, index) {
    const cat = plugin._cat || categoryOf(plugin);
    const installed = isInstalled(plugin.id);
    const favorite = state.favorites.has(plugin.id);
    const stars = plugin.stars != null ? `<span class="card-stat star"><svg><use href="#i-star"/></svg>${formatCount(plugin.stars)}</span>` : '';
    const downloads = plugin.downloads != null ? `<span class="card-stat"><svg><use href="#i-download"/></svg>${formatCount(plugin.downloads)}</span>` : '';
    return `
      <article class="plugin-card" data-open="${esc(plugin.id)}" style="--cat:${esc(cat.color)};--i:${index}">
        ${coverMarkup(plugin)}
        <div class="card-badges">${badgeMarkup(plugin)}</div>
        <button class="card-fav ${favorite ? 'active' : ''}" data-fav="${esc(plugin.id)}" aria-label="${favorite ? '取消收藏' : '收藏插件'}" title="${favorite ? '取消收藏' : '收藏插件'}">
          <svg><use href="#i-heart"/></svg>
        </button>
        <div class="card-body">
          <div class="card-topline">
            <span class="card-cat" style="color:${esc(cat.color)}">${esc(cat.name)}</span>
            <span class="card-verified"><svg><use href="#i-check"/></svg>社区收录</span>
          </div>
          <h3 class="card-title" title="${esc(plugin.name)}">${esc(plugin._short || plugin.name)}</h3>
          <div class="card-owner">@${esc(plugin.owner)}${plugin.version ? ` · v${esc(plugin.version)}` : ''}</div>
          <p class="card-desc">${esc(plugin.desc || plugin.descEn || '社区插件，暂无中文说明。')}</p>
          <div class="card-foot">
            <div class="card-stats">${stars}${downloads}</div>
            <button class="card-install ${installed ? 'installed' : ''}" data-install="${esc(plugin.id)}">
              <svg><use href="#${installed ? 'i-check' : 'i-download'}"/></svg>${installed ? '已安装' : '安装'}
            </button>
          </div>
        </div>
      </article>`;
  }

  function featuredMarkup(item, index) {
    const plugin = state.byId.get(item.id);
    if (!plugin) return '';
    const cat = plugin._cat || categoryOf(plugin);
    return `
      <article class="featured-card" data-open="${esc(item.id)}" style="--accent-cat:${esc(item.accent || cat.color)}">
        <img src="${esc(item.image || imageUrl(plugin.shots?.[0] || ''))}" alt="${esc(item.title)}" loading="${index < 2 ? 'eager' : 'lazy'}" decoding="async" onerror="this.style.display='none'">
        <span class="featured-badge">${esc(cat.icon)}</span>
        <div class="featured-body">
          <span class="featured-tag">${esc(item.kicker || cat.name)}</span>
          <strong>${esc(item.title)}</strong>
          <p>${esc(item.blurb || plugin.desc)}</p>
          <div class="featured-meta">
            <span class="star"><svg><use href="#i-star"/></svg>${formatCount(plugin.stars)}</span>
            <span>@${esc(plugin.owner)}</span>
          </div>
        </div>
      </article>`;
  }

  function skeletonMarkup(count = 9) {
    return Array.from({ length: count }, () => `
      <div class="skeleton-card">
        <div class="skeleton-cover"></div>
        <div class="skeleton-body">
          <div class="skeleton-line w40"></div>
          <div class="skeleton-line w85"></div>
          <div class="skeleton-line w60"></div>
        </div>
      </div>`).join('');
  }

  // ---------------------------------------------------------------------------
  // Results / filters UI
  // ---------------------------------------------------------------------------
  function renderResults() {
    if (!state.plugins) return;
    const list = getFiltered();
    const total = list.length;
    const visible = list.slice(0, state.page * state.pageSize);
    const grid = $('#pluginGrid');
    grid.classList.toggle('list-layout', state.layout === 'list');
    grid.innerHTML = visible.map((plugin, index) => cardMarkup(plugin, Math.min(index, 12))).join('');
    $('#emptyState').hidden = total > 0;
    $('#loadMoreBtn').hidden = visible.length >= total || total === 0;
    $('#loadMoreCount').textContent = `还有 ${formatFull(total - visible.length)} 个`;
    $('#endNote').hidden = visible.length < total || total === 0;
    if (visible.length && visible.length >= total) $('#endNote').hidden = total < 12;

    const heading = state.query
      ? '搜索结果'
      : state.view === 'screenshots'
        ? '界面预览'
        : state.view === 'favorites'
          ? '我的收藏'
          : state.view === 'installed'
            ? '已安装'
            : state.filter === 'shots'
              ? '带界面图'
              : state.category !== 'all'
                ? categoryOf({ category: state.category }).name
                : '全部插件';
    $('#resultTitle').childNodes[0].nodeValue = `${heading} `;
    $('#resultCount').textContent = state.query ? `找到 ${formatFull(total)} 个` : `共 ${formatFull(total)} 个`;

    const chips = [];
    if (state.query) chips.push({ key: 'query', label: `搜索：${state.query}` });
    if (state.category !== 'all') chips.push({ key: 'category', label: `分类：${categoryOf({ category: state.category }).name}` });
    if (state.filter !== 'all') chips.push({ key: 'filter', label: { shots: '有界面图', npm: 'npm 来源', github: 'GitHub 来源', installed: '已安装' }[state.filter] || state.filter });
    if (state.view === 'screenshots') chips.push({ key: 'view', label: '仅界面预览' });
    const activeRoot = $('#activeFilters');
    activeRoot.hidden = chips.length === 0;
    activeRoot.innerHTML = chips.map((chip) => `
      <span class="active-filter">${esc(chip.label)}<button data-remove-filter="${chip.key}" aria-label="移除筛选"><svg><use href="#i-close"/></svg></button></span>`).join('');

    $$('#quickFilters .chip').forEach((button) => {
      const value = button.dataset.filter;
      const active = value === 'all' ? state.filter === 'all' : state.filter === value;
      button.classList.toggle('active', active);
    });
    setActiveNav();
    updateNavCounts();
  }

  function setView(view) {
    state.view = view;
    if (view !== 'discover') state.filter = 'all';
    state.category = 'all';
    resetPaging();
    renderCategories();
    renderResults();
    if (view === 'screenshots') $('#pageScroll').scrollTo({ top: $('#allSection').offsetTop - 80, behavior: 'smooth' });
  }

  function setCategory(category) {
    state.category = category;
    state.view = 'discover';
    state.filter = 'all';
    resetPaging();
    renderCategories();
    renderResults();
    $('#pageScroll').scrollTo({ top: $('#allSection').offsetTop - 80, behavior: 'smooth' });
  }

  function setFilter(filter) {
    state.filter = filter;
    if (filter !== 'all') state.view = 'discover';
    if (filter === 'installed') state.category = 'all';
    resetPaging();
    renderResults();
  }

  function setSort(sort) {
    state.sort = sort;
    resetPaging();
    renderResults();
  }

  // ---------------------------------------------------------------------------
  // Hero / featured
  // ---------------------------------------------------------------------------
  function renderHero() {
    const item = state.featured[state.heroIndex];
    if (!item) return;
    const plugin = state.byId.get(item.id);
    if (!plugin) return;
    const image = $('#heroImage');
    const nextSrc = item.heroImage || item.image || (plugin.shots?.[0] ? imageUrl(plugin.shots[0]) : '');
    image.classList.add('switching');
    image.onload = () => image.classList.remove('switching');
    image.onerror = () => {
      image.onerror = null;
      image.src = appUrl('assets/hero/modlens.jpg');
      image.classList.remove('switching');
    };
    setTimeout(() => {
      image.src = nextSrc;
      image.alt = `${item.title} 界面预览`;
      if (image.complete && image.naturalWidth) image.classList.remove('switching');
    }, 110);
    $('#heroKicker').textContent = item.kicker || categoryOf(plugin).name;
    $('#heroTitleSmall').textContent = item.title;
    $('#heroUrl').textContent = `dsh-market / ${plugin.owner} / ${plugin._short}`;
    $('#heroStars').textContent = formatCount(plugin.stars);
    $('#heroAura').style.background = `radial-gradient(circle at 56% 42%, ${hexToRgba(item.accent || '#64e6cb', 0.18)}, rgba(114, 167, 255, .08) 38%, transparent 68%)`;
    $('#heroThumbs').innerHTML = state.featured.map((entry, index) => `
      <button class="hero-thumb ${index === state.heroIndex ? 'active' : ''}" data-hero="${index}" aria-label="切换到${esc(entry.title)}"></button>`).join('');
    $('#heroBrowser').onclick = () => openDetail(item.id);
    $('#heroBrowser').onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(item.id); }
    };
  }

  function hexToRgba(hex, alpha) {
    const value = String(hex).replace('#', '');
    const full = value.length === 3 ? value.split('').map((char) => char + char).join('') : value;
    const number = parseInt(full, 16);
    if (Number.isNaN(number)) return `rgba(100,230,203,${alpha})`;
    return `rgba(${(number >> 16) & 255},${(number >> 8) & 255},${number & 255},${alpha})`;
  }

  function startHeroCycle() {
    clearInterval(state.heroTimer);
    state.heroTimer = setInterval(() => {
      if (document.hidden) return;
      state.heroIndex = (state.heroIndex + 1) % state.featured.length;
      renderHero();
    }, 9000);
  }

  function renderFeatured() {
    $('#featuredRail').innerHTML = state.featured.map(featuredMarkup).join('');
  }

  function renderSearchHints() {
    const terms = ['视觉', '记忆', '桌宠', '主题', '浏览器', '语音', '工作流', '插件市场', 'MCP', 'Git'];
    $('#hotSearches').innerHTML = terms.map((term) => `<button class="pop-chip" data-search="${esc(term)}">${esc(term)}</button>`).join('');
    const caps = [
      ['fs-read', '读取文件'],
      ['fs-write', '写入文件'],
      ['network', '访问网络'],
      ['shell', '执行命令'],
      ['llm', '调用模型'],
    ];
    $('#hotCaps').innerHTML = caps.map(([cap, label]) => `<button class="pop-chip" data-search="${esc(label)}">${esc(label)}</button>`).join('');
  }

  // ---------------------------------------------------------------------------
  // Drawer
  // ---------------------------------------------------------------------------
  function screenshotMarkup(plugin, limit = 8) {
    const shots = (plugin.shots || []).slice(0, limit);
    if (!shots.length) return '';
    return shots.map((shot, index) => `
      <div class="shot" data-shot="${esc(plugin.id)}" data-shot-index="${index}" title="点击查看大图">
        <img src="${esc(imageUrl(shot))}" alt="${esc(plugin._short)} 界面截图 ${index + 1}" loading="lazy" decoding="async" onerror="this.insertAdjacentHTML('afterend','<div class=&quot;img-fail&quot;>截图加载失败</div>');this.remove()">
      </div>`).join('');
  }

  function relatedFor(plugin) {
    return state.plugins
      .filter((item) => item.id !== plugin.id && item.category === plugin.category)
      .sort((a, b) => (b.shots?.length || 0) - (a.shots?.length || 0) || (b.stars || 0) - (a.stars || 0))
      .slice(0, 3);
  }

  function renderDrawer(plugin) {
    const cat = plugin._cat || categoryOf(plugin);
    const installed = isInstalled(plugin.id);
    const favorite = state.favorites.has(plugin.id);
    const profile = installProfile();
    const command = `dsh plugin --profile ${profile} add ${plugin.spec}`;
    const firstShot = plugin.shots?.[0];
    const heroFallback = `<div class="cover-fallback" style="--cat:${esc(cat.color)}"><div class="cover-rings"></div><span class="cover-glyph">${esc(cat.icon)}</span><span class="cover-word">${esc(plugin.owner)} / ${esc(plugin.name)}</span></div>`;
    const hero = `${heroFallback}${firstShot ? `<img src="${esc(imageUrl(firstShot))}" alt="${esc(plugin._short)} 界面预览" onerror="this.remove()">` : ''}`;
    const caps = (plugin.caps || []).map((cap) => `<span class="cap">${esc(CAP_LABELS[cap] || cap)}</span>`).join('');
    const related = relatedFor(plugin);
    const downloadText = plugin.downloads != null ? `<b>${formatCount(plugin.downloads)}</b><small>30 天下载</small>` : '';
    const starsText = plugin.stars != null ? `<b>${formatCount(plugin.stars)}</b><small>GitHub Stars</small>` : '';

    $('#drawerContent').innerHTML = `
      <div class="drawer-hero" style="--cat:${esc(cat.color)}">
        ${hero}
        <button class="drawer-close" data-close-drawer aria-label="关闭详情"><svg><use href="#i-close"/></svg></button>
        <div class="drawer-hero-tag">
          <span class="card-badge" style="color:${esc(cat.color)}">${esc(cat.icon)} ${esc(cat.name)}</span>
          <span class="card-badge">${esc(KIND_LABELS[plugin.kind] || plugin.kind)}</span>
          ${plugin.featured ? '<span class="card-badge">编辑精选</span>' : ''}
        </div>
      </div>
      <div class="drawer-body">
        <div class="drawer-head">
          <div class="drawer-avatar">${plugin.icon ? `<img src="${esc(imageUrl(plugin.icon))}" alt="" onerror="this.remove()">` : esc(cat.icon)}</div>
          <div class="drawer-title">
            <h2>${esc(plugin._short || plugin.name)}</h2>
            <p>@${esc(plugin.owner)}${plugin.version ? ` · v${esc(plugin.version)}` : ''}${plugin.added ? ` · 收录于 ${formatDate(plugin.added)}` : ''}</p>
          </div>
          <div class="drawer-actions">
            <button class="icon-btn ${favorite ? 'active' : ''}" data-fav="${esc(plugin.id)}" aria-label="${favorite ? '取消收藏' : '收藏'}" title="${favorite ? '取消收藏' : '收藏'}">
              <svg style="${favorite ? 'fill:currentColor;color:#f472b6' : ''}"><use href="#i-heart"/></svg>
            </button>
            <a class="icon-btn" href="${esc(plugin.url)}" target="_blank" rel="noreferrer" aria-label="打开 GitHub 仓库" title="打开 GitHub 仓库"><svg><use href="#i-github"/></svg></a>
          </div>
        </div>
        <p class="drawer-lead">${esc(plugin.desc || plugin.descEn || '社区插件，暂无中文说明。')}</p>
        <div class="drawer-metrics">
          ${starsText ? `<span class="metric">${starsText}</span>` : ''}
          ${downloadText ? `<span class="metric">${downloadText}</span>` : ''}
          <span class="metric"><b>${esc(plugin.version || '—')}</b><small>版本</small></span>
          <span class="metric"><b>${esc(formatDate(plugin.added))}</b><small>收录日期</small></span>
        </div>
        <div class="drawer-install">
          <div class="install-copy">
            <small>安装到本机</small>
            <code>${esc(command)}</code>
          </div>
          <button class="primary-btn" data-install="${esc(plugin.id)}"><svg><use href="#${installed ? 'i-check' : 'i-download'}"/></svg>${installed ? '已安装' : '安装'}</button>
        </div>
        <p class="install-note">安装会调用本机 <b>dsh plugin</b> 写入 profile <b>${esc(profile)}</b>。安装完成后通常需要刷新页面或重启 DSH。</p>

        ${plugin.shots?.length ? `
        <section class="drawer-section">
          <div class="drawer-section-head"><h3>界面预览</h3><span>${plugin.shots.length} 张 · 点击放大</span></div>
          <div class="shot-grid">${screenshotMarkup(plugin)}</div>
        </section>` : ''}

        <section class="drawer-section">
          <div class="drawer-section-head"><h3>关于这个插件</h3><span>中文说明</span></div>
          <div class="desc-block">${esc(plugin.desc || '暂无中文说明。')}</div>
          ${plugin.descEn ? `<div class="desc-block en">${esc(plugin.descEn)}</div>` : ''}
        </section>

        <section class="drawer-section">
          <div class="drawer-section-head"><h3>能力与权限</h3><span>安装前请确认</span></div>
          ${caps ? `<div class="cap-list">${caps}</div>` : '<p class="desc-block">该插件未声明额外能力。</p>'}
          ${(plugin.redLines || []).length ? `<div class="redline">注意：${esc(plugin.redLines.join('；'))}</div>` : ''}
          <div class="redline">第三方代码提醒：插件由社区作者发布，不是官方审核过的应用。安装前请打开仓库，确认来源与代码内容。</div>
        </section>

        <section class="drawer-section">
          <div class="drawer-section-head"><h3>来源与安装</h3><span>可复制到终端</span></div>
          <div class="detail-links">
            <a class="detail-link" href="${esc(plugin.url)}" target="_blank" rel="noreferrer"><svg><use href="#i-github"/></svg>GitHub 仓库</a>
            <button class="detail-link" data-copy="${esc(command)}"><svg><use href="#i-copy"/></svg>复制安装命令</button>
            <button class="detail-link" data-copy="${esc(plugin.spec)}"><svg><use href="#i-terminal"/></svg>复制包名</button>
          </div>
          ${plugin.npm ? `<p class="install-note">npm 包：<b>${esc(plugin.npm)}</b></p>` : ''}
        </section>

        ${related.length ? `
        <section class="drawer-section">
          <div class="drawer-section-head"><h3>同类推荐</h3><span>${esc(cat.name)}</span></div>
          <div class="related-list">
            ${related.map((item) => `
              <button class="related-item" data-open="${esc(item.id)}" style="--cat:${esc((item._cat || categoryOf(item)).color)}">
                <span class="related-thumb">${item.shots?.[0] ? `<img src="${esc(imageUrl(item.shots[0]))}" alt="" loading="lazy" onerror="this.remove()">` : esc((item._cat || categoryOf(item)).icon)}</span>
                <span class="related-copy"><strong>${esc(item._short || item.name)}</strong><small>${esc(item.desc).slice(0, 54)}</small></span>
                <span class="related-arrow"><svg><use href="#i-arrow"/></svg></span>
              </button>`).join('')}
          </div>
        </section>` : ''}
      </div>`;
  }

  function openDetail(id) {
    const plugin = state.byId.get(id);
    if (!plugin) return;
    state.detailId = id;
    addRecent(id);
    renderDrawer(plugin);
    $('#drawerRoot').classList.add('open');
    $('#drawerRoot').setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    $('#drawer').scrollTop = 0;
    $('#drawerContent').scrollTop = 0;
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}#p=${encodeURIComponent(id)}`);
    } catch (_) {}
  }

  function closeDetail() {
    state.detailId = null;
    $('#drawerRoot').classList.remove('open');
    $('#drawerRoot').setAttribute('aria-hidden', 'true');
    if (!$('#modalRoot').classList.contains('open')) document.body.style.overflow = '';
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    } catch (_) {}
  }

  function toggleFavorite(id) {
    if (state.favorites.has(id)) {
      state.favorites.delete(id);
      toast('已取消收藏');
    } else {
      state.favorites.add(id);
      toast('已加入收藏');
    }
    saveFavorites();
    renderResults();
    renderFeatured();
    if (state.detailId === id) {
      const plugin = state.byId.get(id);
      if (plugin) renderDrawer(plugin);
    }
  }

  // ---------------------------------------------------------------------------
  // Lightbox
  // ---------------------------------------------------------------------------
  function openLightbox(pluginId, index = 0) {
    const plugin = state.byId.get(pluginId);
    if (!plugin?.shots?.length) return;
    state.lightbox = { images: plugin.shots.slice(0, 8), index, title: plugin._short };
    updateLightbox();
    $('#lightbox').classList.add('open');
    $('#lightbox').setAttribute('aria-hidden', 'false');
  }

  function updateLightbox() {
    const { images, index, title } = state.lightbox;
    if (!images.length) return;
    $('#lightboxImage').src = imageUrl(images[index]);
    $('#lightboxImage').alt = `${title} 界面截图 ${index + 1}`;
    $('#lightboxCaption').textContent = `${title} · ${index + 1} / ${images.length}`;
    $('[data-lightbox-prev]').style.display = images.length > 1 ? '' : 'none';
    $('[data-lightbox-next]').style.display = images.length > 1 ? '' : 'none';
  }

  function closeLightbox() {
    $('#lightbox').classList.remove('open');
    $('#lightbox').setAttribute('aria-hidden', 'true');
    $('#lightboxImage').removeAttribute('src');
  }

  function stepLightbox(delta) {
    const { images, index } = state.lightbox;
    if (!images.length) return;
    state.lightbox.index = (index + delta + images.length) % images.length;
    updateLightbox();
  }

  // ---------------------------------------------------------------------------
  // Install modal
  // ---------------------------------------------------------------------------
  function installProfile() {
    const saved = localStorage.getItem(PROFILE_KEY);
    if (saved && state.config?.profiles?.some((profile) => profile.name === saved)) return saved;
    return state.config?.defaultProfile || 'web';
  }

  function installCommand(plugin, profile = installProfile()) {
    return `dsh plugin --profile ${profile} add ${plugin.spec}`;
  }

  function profileOptions(selected) {
    const profiles = state.config?.profiles || [{ name: 'web', label: 'web', managed: false }];
    return profiles.map((profile) => `
      <option value="${esc(profile.name)}" ${profile.name === selected ? 'selected' : ''}>${esc(profile.label || profile.name)}</option>`).join('');
  }

  function openInstall(id) {
    const plugin = state.byId.get(id);
    if (!plugin) return;
    if (isInstalled(id)) {
      toast('这个插件已经安装过了');
      return;
    }
    const selected = installProfile();
    const managed = state.config?.profiles?.find((profile) => profile.name === selected)?.managed;
    const cat = plugin._cat || categoryOf(plugin);
    $('#installContent').innerHTML = `
      <div class="modal-head" style="--cat:${esc(cat.color)}">
        <div class="modal-icon">${plugin.icon ? `<img src="${esc(imageUrl(plugin.icon))}" alt="" onerror="this.remove()">` : esc(cat.icon)}</div>
        <div>
          <h2 id="installTitle">安装 ${esc(plugin._short || plugin.name)}</h2>
          <p>${esc(cat.name)} · ${esc(KIND_LABELS[plugin.kind] || plugin.kind)} · ${esc(plugin.owner)}</p>
        </div>
        <button class="modal-close" data-close-modal aria-label="关闭"><svg><use href="#i-close"/></svg></button>
      </div>
      <div class="modal-body">
        <p class="modal-lead">确认来源后，市场会调用本机 dsh 把插件写入所选 profile。安装完成后刷新页面，或在 DSH 中重新加载。</p>
        <div class="field-label"><span>安装到哪个 profile</span><span>当前 DSH：${esc(state.config?.dshVersion || '检测中')}</span></div>
        <div class="profile-row">
          <select class="profile-select" id="installProfile">${profileOptions(selected)}</select>
        </div>
        <div class="warn-box" id="profileWarn" ${managed ? '' : 'hidden'}>
          <svg><use href="#i-info"/></svg>
          <span>桌面版 profile 由 DSH 应用管理。若这里安装失败，请打开 DSH 的「设置 → 插件」安装；或选择 web profile 供命令行版使用。</span>
        </div>
        <div class="command-box">
          <div class="command-top"><span>将要执行的命令</span><button class="copy-btn" data-copy="${esc(installCommand(plugin, selected))}"><svg><use href="#i-copy"/></svg>复制</button></div>
          <pre class="command-code" id="installCommandText">${esc(installCommand(plugin, selected))}</pre>
        </div>
        <label class="check-row"><input type="checkbox" id="trustCheck"><span>我确认这是社区第三方插件，并已了解它会以本机权限运行。安装前我会自行审查来源。</span></label>
        <div class="modal-actions">
          <button class="outline-btn" data-close-modal>取消</button>
          <button class="primary-btn" id="startInstallBtn" disabled><svg><use href="#i-download"/></svg>确认安装</button>
        </div>
        <div id="installProgress"></div>
      </div>`;
    $('#modalRoot').classList.add('open');
    $('#modalRoot').setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    $('#installProfile').addEventListener('change', () => {
      const profile = $('#installProfile').value;
      localStorage.setItem(PROFILE_KEY, profile);
      $('#installCommandText').textContent = installCommand(plugin, profile);
      const isManaged = state.config?.profiles?.find((item) => item.name === profile)?.managed;
      $('#profileWarn').hidden = !isManaged;
      const copy = $('#installContent .copy-btn');
      if (copy) copy.dataset.copy = installCommand(plugin, profile);
    });
    $('#trustCheck').addEventListener('change', (event) => {
      $('#startInstallBtn').disabled = !event.target.checked;
    });
    $('#startInstallBtn').addEventListener('click', () => startInstall(plugin));
  }

  function closeModal(force = false) {
    if (state.installJob?.status === 'running' && !force) {
      toast('安装正在进行，请等待完成', 'error');
      return;
    }
    if (state.installSource) {
      state.installSource.close();
      state.installSource = null;
    }
    state.installJob = null;
    $('#modalRoot').classList.remove('open');
    $('#modalRoot').setAttribute('aria-hidden', 'true');
    if (!$('#drawerRoot').classList.contains('open')) document.body.style.overflow = '';
  }

  async function startInstall(plugin) {
    const profile = $('#installProfile')?.value || installProfile();
    const command = installCommand(plugin, profile);
    $('#startInstallBtn').disabled = true;
    $('#startInstallBtn').innerHTML = '<span class="spinner"></span>正在安装…';
    $('#installProgress').innerHTML = `
      <div class="install-terminal">
        <div class="terminal-top"><span class="terminal-dots"><i></i><i></i><i></i></span><span>dsh plugin · ${esc(profile)}</span></div>
        <pre class="terminal-out" id="terminalOut"></pre>
      </div>
      <div class="install-status" id="installStatus"><span class="spinner"></span><span>正在准备安装…</span></div>`;
    const terminal = $('#terminalOut');
    const status = $('#installStatus');
    const append = (text) => {
      terminal.textContent += text;
      terminal.scrollTop = terminal.scrollHeight;
    };

    try {
      const response = await fetch(appUrl('api/install'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DSH-Market': 'install' },
        body: JSON.stringify({ id: plugin.id, profile }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `安装请求失败（HTTP ${response.status}）`);
      state.installJob = { id: payload.jobId, status: 'running', pluginId: plugin.id };
      status.innerHTML = '<span class="spinner"></span><span>正在安装，请保持页面打开…</span>';
      const source = new EventSource(appUrl(`api/install/${payload.jobId}/events`));
      state.installSource = source;
      source.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch (_) { return; }
        if (data.type === 'log') append(data.text);
        if (data.type === 'start') append(`$ ${data.command}\n\n`);
        if (data.type === 'end') {
          source.close();
          state.installSource = null;
          state.installJob = { id: payload.jobId, status: data.status, pluginId: plugin.id };
          if (data.status === 'success') {
            state.installed.set(plugin.id, { at: Date.now(), profile });
            saveInstalled();
            loadInstalled().catch(() => {});
            updateNavCounts();
            status.innerHTML = '<span class="status-success">✓ 安装完成</span><span style="color:#71839b">刷新页面或重启 DSH 后生效</span>';
            $('#startInstallBtn').innerHTML = '<svg><use href="#i-check"/></svg>安装完成';
            $('#startInstallBtn').disabled = true;
            $('#installProgress').insertAdjacentHTML('beforeend', `
              <div class="modal-actions">
                <button class="outline-btn" data-close-modal>完成</button>
                <button class="outline-btn" data-copy="${esc(command)}"><svg><use href="#i-copy"/></svg>复制命令</button>
              </div>`);
            toast('安装完成，刷新页面或重启 DSH 后生效');
            renderResults();
            if (state.detailId === plugin.id) renderDrawer(plugin);
          } else {
            status.innerHTML = `<span class="status-error">✕ 安装失败（退出码 ${data.code ?? '未知'}）</span>`;
            $('#startInstallBtn').disabled = true;
            $('#startInstallBtn').textContent = '安装失败';
            $('#installProgress').insertAdjacentHTML('beforeend', `
              <div class="warn-box"><svg><use href="#i-info"/></svg><span>可复制命令到终端重试；桌面版请优先使用 DSH 的「设置 → 插件」安装。</span></div>
              <div class="modal-actions">
                <button class="outline-btn" data-close-modal>关闭</button>
                <button class="outline-btn" data-copy="${esc(command)}"><svg><use href="#i-copy"/></svg>复制命令</button>
              </div>`);
          }
        }
      };
      source.onerror = () => {
        if (state.installSource === source) {
          source.close();
          state.installSource = null;
        }
      };
    } catch (error) {
      append(`\n[market] ${error.message}\n`);
      status.innerHTML = `<span class="status-error">✕ ${esc(error.message)}</span>`;
      $('#startInstallBtn').disabled = true;
      $('#startInstallBtn').textContent = '安装失败';
      $('#installProgress').insertAdjacentHTML('beforeend', `
        <div class="warn-box"><svg><use href="#i-info"/></svg><span>本地安装服务不可用。你仍可复制命令，在终端手动执行。</span></div>
        <div class="modal-actions"><button class="outline-btn" data-close-modal>关闭</button><button class="outline-btn" data-copy="${esc(command)}"><svg><use href="#i-copy"/></svg>复制命令</button></div>`);
    }
  }

  function openGuide() {
    $('#installContent').innerHTML = `
      <div class="modal-head">
        <div class="modal-icon">⌘</div>
        <div><h2 id="installTitle">安装说明</h2><p>一键安装如何工作 · 以及失败时怎么办</p></div>
        <button class="modal-close" data-close-modal aria-label="关闭"><svg><use href="#i-close"/></svg></button>
      </div>
      <div class="modal-body">
        <p class="modal-lead">这个市场本身不托管插件。每一条都指向作者的 GitHub 或 npm 包，安装动作由你本机的 dsh CLI 完成。</p>
        <div class="drawer-section" style="margin-top:4px">
          <div class="drawer-section-head"><h3>推荐流程</h3><span>3 步</span></div>
          <div class="desc-block">1. 在插件详情里确认作者、仓库和界面截图。
2. 点「安装」，选择要写入的 profile，再确认第三方代码提醒。
3. 安装完成后刷新 DSH 页面；如果插件提供了侧栏或设置入口，按它的说明启用。</div>
        </div>
        <div class="drawer-section">
          <div class="drawer-section-head"><h3>桌面版用户</h3><span>重要</span></div>
          <div class="desc-block">DSH Desktop 的 desktop profile 由应用管理。命令行安装可能被拒绝，或者安装后不会出现在桌面版里。遇到这种情况，请使用 DSH 的「设置 → 插件」安装，或把 profile 切换为 web 供命令行版使用。</div>
        </div>
        <div class="drawer-section">
          <div class="drawer-section-head"><h3>手动安装</h3><span>复制即用</span></div>
          <div class="command-box">
            <div class="command-top"><span>在终端执行</span><button class="copy-btn" data-copy="dsh plugin --profile web add dsh-meme"><svg><use href="#i-copy"/></svg>复制</button></div>
            <pre class="command-code">dsh plugin --profile web add &lt;插件包名&gt;</pre>
          </div>
          <p class="install-note">把 &lt;插件包名&gt; 换成详情页「复制包名」得到的内容。GitHub 插件通常以 <b>github:owner/repo</b> 开头。</p>
        </div>
        <div class="warn-box"><svg><use href="#i-shield"/></svg><span>安全提醒：插件会以你的本机权限运行，可能读取文件、访问网络或执行命令。安装前请打开仓库确认来源。</span></div>
        <div class="modal-actions"><button class="primary-btn" data-close-modal>我知道了</button></div>
      </div>`;
    $('#modalRoot').classList.add('open');
    $('#modalRoot').setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  // ---------------------------------------------------------------------------
  // Search popover
  // ---------------------------------------------------------------------------
  function openSearchPop() {
    if ($('#searchInput').value.trim()) return;
    $('#searchPop').hidden = false;
  }
  function closeSearchPop() {
    $('#searchPop').hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------
  function bindEvents() {
    $('#searchInput').addEventListener('input', (event) => {
      state.query = event.target.value;
      $('#searchWrap .searchbox').classList.toggle('has-value', Boolean(state.query));
      resetPaging();
      renderResults();
      if (state.query.trim()) closeSearchPop(); else openSearchPop();
    });
    $('#searchInput').addEventListener('focus', openSearchPop);
    $('#searchInput').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.target.value = '';
        state.query = '';
        $('#searchWrap .searchbox').classList.remove('has-value');
        closeSearchPop();
        resetPaging();
        renderResults();
        event.target.blur();
      }
    });
    $('#searchClear').addEventListener('click', () => {
      $('#searchInput').value = '';
      state.query = '';
      $('#searchWrap .searchbox').classList.remove('has-value');
      resetPaging();
      renderResults();
      $('#searchInput').focus();
    });

    document.addEventListener('click', (event) => {
      if (!event.target.closest('#searchWrap')) closeSearchPop();
    });

    $('#searchPop').addEventListener('click', (event) => {
      const button = event.target.closest('[data-search]');
      if (!button) return;
      $('#searchInput').value = button.dataset.search;
      state.query = button.dataset.search;
      $('#searchWrap .searchbox').classList.add('has-value');
      closeSearchPop();
      resetPaging();
      renderResults();
      $('#allSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    $('#sortSelect').addEventListener('change', (event) => setSort(event.target.value));
    $('#quickFilters').addEventListener('click', (event) => {
      const button = event.target.closest('[data-filter]');
      if (button) setFilter(button.dataset.filter);
    });
    $$('.view-toggle button').forEach((button) => {
      button.addEventListener('click', () => {
        state.layout = button.dataset.layout;
        $$('.view-toggle button').forEach((item) => item.classList.toggle('active', item === button));
        renderResults();
      });
    });
    $('#loadMoreBtn').addEventListener('click', () => {
      state.page += 1;
      renderResults();
      const cards = $$('#pluginGrid .plugin-card');
      const target = cards[Math.max(0, (state.page - 2) * state.pageSize)];
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    $('#activeFilters').addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-filter]');
      if (!button) return;
      const key = button.dataset.removeFilter;
      if (key === 'query') {
        $('#searchInput').value = '';
        state.query = '';
        $('#searchWrap .searchbox').classList.remove('has-value');
      }
      if (key === 'category') state.category = 'all';
      if (key === 'filter') state.filter = 'all';
      if (key === 'view') state.view = 'discover';
      resetPaging();
      renderCategories();
      renderResults();
    });
    $('#resetFilters').addEventListener('click', clearAllFilters);
    $('#exploreBtn').addEventListener('click', () => $('#allSection').scrollIntoView({ behavior: 'smooth' }));
    $('#randomBtn').addEventListener('click', randomPlugin);
    $('#randomHero').addEventListener('click', randomPlugin);
    $('#syncBtn').addEventListener('click', syncCatalog);
    $('#guideBtn').addEventListener('click', openGuide);
    $('#hostRefresh').addEventListener('click', async (event) => {
      event.stopPropagation();
      toast('正在刷新本机信息…');
      await loadConfig();
      toast('本机信息已更新');
    });

    // Sidebar nav
    $$('.nav-item').forEach((item) => {
      item.addEventListener('click', () => {
        setView(item.dataset.view);
        closeMobileNav();
        $('#allSection').scrollIntoView({ behavior: 'smooth' });
      });
    });
    $('#categoryList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-category]');
      if (button) setCategory(button.dataset.category);
    });
    $$('[data-clear-category]').forEach((button) => button.addEventListener('click', () => setCategory('all')));

    // Sidebar mobile
    $('#menuBtn').addEventListener('click', () => {
      $('#app').classList.toggle('sidebar-open');
      state.isMobileNav = $('#app').classList.contains('sidebar-open');
    });
    $('#sidebarScrim').addEventListener('click', closeMobileNav);

    // Hero thumbs
    $('#heroThumbs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-hero]');
      if (!button) return;
      state.heroIndex = Number(button.dataset.hero);
      renderHero();
      startHeroCycle();
    });
    $('#heroBrowser').addEventListener('mouseenter', () => clearInterval(state.heroTimer));
    $('#heroBrowser').addEventListener('mouseleave', startHeroCycle);

    // Global delegated actions
    document.addEventListener('click', (event) => {
      const open = event.target.closest('[data-open]');
      if (open && !event.target.closest('[data-fav]') && !event.target.closest('[data-install]')) {
        openDetail(open.dataset.open);
        return;
      }
      const install = event.target.closest('[data-install]');
      if (install) {
        event.stopPropagation();
        openInstall(install.dataset.install);
        return;
      }
      const favorite = event.target.closest('[data-fav]');
      if (favorite) {
        event.stopPropagation();
        toggleFavorite(favorite.dataset.fav);
        return;
      }
      const copy = event.target.closest('[data-copy]');
      if (copy) {
        event.stopPropagation();
        copyText(copy.dataset.copy);
        return;
      }
      const shot = event.target.closest('[data-shot]');
      if (shot) {
        openLightbox(shot.dataset.shot, Number(shot.dataset.shotIndex) || 0);
        return;
      }
      if (event.target.closest('[data-close-drawer]')) {
        closeDetail();
        return;
      }
      if (event.target.closest('[data-close-modal]')) {
        closeModal();
        return;
      }
      if (event.target.closest('[data-close-lightbox]')) {
        closeLightbox();
        return;
      }
      if (event.target.closest('[data-lightbox-prev]')) {
        stepLightbox(-1);
        return;
      }
      if (event.target.closest('[data-lightbox-next]')) {
        stepLightbox(1);
      }
    });

    // Keyboard
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const typing = target.matches('input, textarea, select') || target.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        $('#searchInput').focus();
        $('#searchInput').select();
        return;
      }
      if (event.key === '/' && !typing) {
        event.preventDefault();
        $('#searchInput').focus();
        return;
      }
      if (event.key === 'Escape') {
        if ($('#lightbox').classList.contains('open')) closeLightbox();
        else if ($('#modalRoot').classList.contains('open')) closeModal();
        else if ($('#drawerRoot').classList.contains('open')) closeDetail();
        else closeSearchPop();
        if ($('#app').classList.contains('sidebar-open')) closeMobileNav();
      }
      if ($('#lightbox').classList.contains('open')) {
        if (event.key === 'ArrowLeft') stepLightbox(-1);
        if (event.key === 'ArrowRight') stepLightbox(1);
      }
    });

    // Lightbox click backdrop
    $('#lightbox').addEventListener('click', (event) => {
      if (event.target === $('#lightbox')) closeLightbox();
    });
    $('#drawerRoot').addEventListener('click', (event) => {
      if (event.target.matches('[data-close-drawer]')) closeDetail();
    });
    $('#modalRoot').addEventListener('click', (event) => {
      if (event.target.matches('[data-close-modal]')) closeModal();
    });

    window.addEventListener('hashchange', () => {
      const match = location.hash.match(/^#p=(.+)$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (state.byId.has(id) && state.detailId !== id) openDetail(id);
      } else if (state.detailId) {
        closeDetail();
      }
    });
  }

  async function syncCatalog() {
    if (state.syncBusy) return;
    if (!state.catalogApi) {
      toast('当前宿主还没有加载实时目录接口，请重启一次 DSH', 'error');
      return;
    }
    state.syncBusy = true;
    const button = $('#syncBtn');
    if (button) {
      button.disabled = true;
      button.classList.add('syncing');
    }
    try {
      await loadCatalog(true);
      renderCategories();
      renderFeatured();
      renderHero();
      state.page = 1;
      renderResults();
      updateNavCounts();
      if (state.live) {
        toast(`已同步 ${formatFull(state.plugins.length)} 个插件`);
      } else {
        toast(state.liveError ? `同步失败：${state.liveError}` : '同步失败，继续使用本地快照', 'error');
      }
    } catch (error) {
      toast(`同步失败：${error.message}`, 'error');
    } finally {
      state.syncBusy = false;
      if (button) {
        button.disabled = false;
        button.classList.remove('syncing');
      }
    }
  }

  function closeMobileNav() {
    $('#app').classList.remove('sidebar-open');
    state.isMobileNav = false;
  }

  function randomPlugin() {
    const pool = state.plugins.filter((plugin) => plugin.shots?.length && plugin.desc);
    const plugin = pool[Math.floor(Math.random() * pool.length)] || state.plugins[Math.floor(Math.random() * state.plugins.length)];
    if (plugin) openDetail(plugin.id);
  }

  function resetPageScroll() {
    try {
      if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      const pageScroll = $('#pageScroll');
      if (pageScroll) pageScroll.scrollTop = 0;
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function boot() {
    loadStored();
    $('#pluginGrid').innerHTML = skeletonMarkup(9);
    bindEvents();
    renderSearchHints();
    updateNavCounts();

    try {
      await Promise.all([loadCatalog(), loadConfig(), loadInstalled()]);
      renderCategories();
      updateNavCounts();
      renderFeatured();
      renderHero();
      startHeroCycle();
      renderResults();
      updateNavCounts();
      setInterval(refreshInstalled, 5000);
      window.addEventListener('focus', refreshInstalled);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshInstalled();
      });
      const syncButton = $('#syncBtn');
      if (syncButton) syncButton.hidden = !state.catalogApi;
      const hero = state.featured[0];
      if (hero) $('#heroImage').src = hero.heroImage || hero.image;
      const hash = location.hash.match(/^#p=(.+)$/);
      if (hash) {
        const id = decodeURIComponent(hash[1]);
        if (state.byId.has(id)) setTimeout(() => openDetail(id), 240);
      }
      try {
        if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
        resetPageScroll();
        setTimeout(resetPageScroll, 450);
        window.addEventListener('load', resetPageScroll, { once: true });
      } catch (_) {}
    } catch (error) {
      console.error(error);
      $('#pluginGrid').innerHTML = '';
      $('#emptyState').hidden = false;
      $('#emptyState').querySelector('h3').textContent = '目录加载失败';
      $('#emptyState').querySelector('p').textContent = `${error.message}。请确认本地服务正在运行。`;
      toast(error.message, 'error');
    }
  }

  boot();
})();
