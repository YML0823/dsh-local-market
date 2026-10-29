#!/usr/bin/env node
'use strict';

/**
 * DSH 插件市场 · 本地服务
 * - 托管静态市场页面
 * - 代理 GitHub / 用户附件截图（带本地缓存）
 * - 调用本机 dsh CLI 安装插件（SSE 实时日志）
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { normalizeCatalog, FEATURED, collectInstalled, resolveInstalledName } = require('./lib/catalog.js');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_DIR = path.join(ROOT, 'cache');
const IMAGE_CACHE = path.join(CACHE_DIR, 'images');
const DATA_FILE = path.join(PUBLIC_DIR, 'data', 'plugins.json');
const PORT = Number(process.env.PORT || 7788);
const HOST = process.env.HOST || '127.0.0.1';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const INSTALL_TIMEOUT = Number(process.env.INSTALL_TIMEOUT_MS || 12 * 60 * 1000);
const MAX_BODY = 64 * 1024;
const MAX_IMAGE = 16 * 1024 * 1024;
const LIVE_URL = process.env.CATALOG_LIVE_URL || 'https://awesome-dsh-plugin.com/plugins.json';
const LIVE_TTL = 10 * 60 * 1000;

fs.mkdirSync(IMAGE_CACHE, { recursive: true });

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
let catalog = { ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')), featured: FEATURED };
let pluginById = new Map(catalog.plugins.map((plugin) => [plugin.id, plugin]));
let live = { source: 'snapshot', fetchedAt: 0, error: null, pending: null };
console.log(`[market] catalog snapshot: ${catalog.plugins.length} plugins`);

async function refreshCatalog(force = false) {
  if (!force && live.fetchedAt && Date.now() - live.fetchedAt < LIVE_TTL) return catalog;
  if (live.pending) return live.pending;
  live.pending = (async () => {
    try {
      const response = await fetch(LIVE_URL, {
        signal: AbortSignal.timeout(60000),
        headers: { Accept: 'application/json', 'User-Agent': 'dsh-local-market/1.0' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = await response.json();
      const next = normalizeCatalog(raw);
      catalog = next;
      pluginById = new Map(next.plugins.map((plugin) => [plugin.id, plugin]));
      live = { source: 'live', fetchedAt: Date.now(), error: null, pending: null };
      console.log(`[market] catalog live: ${catalog.plugins.length} plugins`);
    } catch (error) {
      live.error = error.message;
      live.source = 'snapshot';
      console.warn('[market] catalog live refresh failed:', error.message);
    } finally {
      live.pending = null;
    }
    return catalog;
  })();
  return live.pending;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const IMAGE_HOSTS = new Set([
  'raw.githubusercontent.com',
  'github.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'camo.githubusercontent.com',
  'media.githubusercontent.com',
  'avatars.githubusercontent.com',
  'objects.githubusercontent.com',
  'github.githubassets.com',
  'img.shields.io',
]);

function findDsh() {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN;
  try {
    const result = spawnSync('where.exe', ['dsh'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const lines = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const cmd = lines.find((line) => /\.cmd$/i.test(line)) || lines[0];
    if (cmd && fs.existsSync(cmd)) return cmd;
  } catch (_) {}
  return process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
}

function readProfiles() {
  const dir = path.join(DSH_HOME, 'profiles');
  const profiles = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const profileDir = path.join(dir, entry.name);
      const pkgFile = path.join(profileDir, 'package.json');
      let pkg = null;
      try {
        pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      } catch (_) {}
      const managed = entry.name === 'desktop' || /desktop/i.test(pkg?.name || '');
      profiles.push({
        name: entry.name,
        dir: profileDir,
        exists: true,
        managed,
        packageName: pkg?.name || null,
        bundles: pkg?.dsh?.profile?.bundles || [],
        label: managed ? `${entry.name}（桌面版，由应用管理）` : entry.name,
      });
    }
  } catch (_) {}
  // `dsh plugin --profile web` may create the profile on first use.
  if (!profiles.some((profile) => profile.name === 'web')) {
    profiles.push({
      name: 'web',
      dir: path.join(dir, 'web'),
      exists: false,
      managed: false,
      packageName: 'dsh-profile-web',
      bundles: [],
      label: 'web（首次安装时创建）',
    });
  }
  profiles.sort((a, b) => {
    if (a.managed !== b.managed) return a.managed ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const defaultProfile = profiles.find((profile) => profile.managed)?.name || profiles[0]?.name || 'web';
  return { profiles, defaultProfile, profilesDir: dir };
}

const DSH_BIN = findDsh();
const versionResult = spawnSync(`"${DSH_BIN.replace(/"/g, '""')}" --version`, {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 12000,
  shell: true,
});
const DSH_VERSION = String(versionResult.stdout || versionResult.stderr || '').trim().split(/\r?\n/)[0] || null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(res, status, body) {
  const raw = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': raw.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(raw);
}

function text(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function cleanAnsi(value) {
  return String(value || '').replace(/\r/g, '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function safeSpec(spec) {
  const value = String(spec || '').trim();
  if (!value || value.length > 2048) return false;
  if (/[\r\n"`<>|^]/.test(value)) return false;
  if (/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9.^~*+_-]+)?$/i.test(value)) return true;
  if (/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#path:\/[A-Za-z0-9_./-]+)?$/i.test(value)) return true;
  if (/^https:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./?=&%+~-]+$/i.test(value)) return true;
  return false;
}

function quoteCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function fileEtag(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

// ---------------------------------------------------------------------------
// Image proxy
// ---------------------------------------------------------------------------
const imageMeta = new Map();

function imageCachePath(url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  return path.join(IMAGE_CACHE, hash);
}

async function fetchImage(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !IMAGE_HOSTS.has(parsed.hostname)) {
    throw new Error('image host is not allowed');
  }
  const candidates = [];
  if (parsed.hostname === 'raw.githubusercontent.com') {
    candidates.push(`https://gh-proxy.com/${url}`);
    candidates.push(`https://ghproxy.net/${url}`);
  }
  candidates.push(url);

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DSH-Market/1.0',
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          Referer: 'https://github.com/',
        },
      });
      if (!response.ok) {
        lastError = new Error(`upstream HTTP ${response.status}`);
        continue;
      }
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!type.startsWith('image/')) {
        lastError = new Error(`upstream content-type ${type || 'unknown'}`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_IMAGE) throw new Error('image too large');
      return { buffer, type };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('image fetch failed');
}

async function serveImage(req, res, requestUrl) {
  const target = requestUrl.searchParams.get('u');
  if (!target) return text(res, 400, 'missing image url');
  let url;
  try {
    url = new URL(target).href;
  } catch (_) {
    return text(res, 400, 'invalid image url');
  }
  const cacheFile = imageCachePath(url);
  const metaFile = `${cacheFile}.json`;
  try {
    const [buffer, metaRaw] = await Promise.all([fsp.readFile(cacheFile), fsp.readFile(metaFile, 'utf8')]);
    const meta = JSON.parse(metaRaw);
    res.writeHead(200, {
      'Content-Type': meta.type || 'image/png',
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(buffer);
  } catch (_) {}

  try {
    const { buffer, type } = await fetchImage(url);
    await Promise.all([
      fsp.writeFile(cacheFile, buffer),
      fsp.writeFile(metaFile, JSON.stringify({ type, url, savedAt: new Date().toISOString() })),
    ]);
    imageMeta.set(url, type);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buffer);
  } catch (error) {
    text(res, 502, `image unavailable: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Install jobs
// ---------------------------------------------------------------------------
const jobs = new Map();
let runningJobId = null;

function createJob(plugin, profile, action = 'install', packageName = null) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id,
    pluginId: plugin.id,
    pluginName: plugin.name,
    profile,
    action,
    packageName,
    spec: plugin.spec,
    command: action === 'uninstall'
      ? `${quoteCmd(DSH_BIN)} plugin --profile ${quoteCmd(profile)} remove ${quoteCmd(packageName)}`
      : `${quoteCmd(DSH_BIN)} plugin --profile ${quoteCmd(profile)} add ${quoteCmd(plugin.spec)}`,
    status: 'running',
    code: null,
    output: '',
    events: [],
    listeners: new Set(),
    startedAt: Date.now(),
    endedAt: null,
    child: null,
  };
  jobs.set(id, job);
  if (jobs.size > 30) {
    for (const [key, value] of jobs) {
      if (key !== id && value.status !== 'running') jobs.delete(key);
      if (jobs.size <= 30) break;
    }
  }
  return job;
}

function emitJob(job, event) {
  const payload = { ...event, at: Date.now() };
  job.events.push(payload);
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const listener of job.listeners) {
    try {
      listener.write(line);
    } catch (_) {}
  }
}

function startJob(job, profileDir) {
  const isWindows = process.platform === 'win32';
  const child = spawn(job.command, {
    cwd: profileDir && fs.existsSync(profileDir) ? profileDir : ROOT,
    shell: true,
    windowsHide: true,
    env: {
      ...process.env,
      CI: process.env.CI || '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });
  job.child = child;
  runningJobId = job.id;
  emitJob(job, { type: 'start', command: job.command, plugin: job.pluginName, profile: job.profile, action: job.action });

  const onData = (stream) => (chunk) => {
    const value = cleanAnsi(chunk.toString('utf8'));
    job.output = (job.output + value).slice(-120000);
    emitJob(job, { type: 'log', text: value });
  };
  child.stdout.on('data', onData('stdout'));
  child.stderr.on('data', onData('stderr'));

  const timer = setTimeout(() => {
    if (job.status === 'running') {
      emitJob(job, { type: 'log', text: `\n[market] 安装超时（${Math.round(INSTALL_TIMEOUT / 1000)} 秒），正在终止…\n` });
      try {
        if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        else child.kill('SIGTERM');
      } catch (_) {}
    }
  }, INSTALL_TIMEOUT);

  child.on('error', (error) => {
    clearTimeout(timer);
    job.status = 'error';
    job.code = -1;
    job.endedAt = Date.now();
    emitJob(job, { type: 'log', text: `\n[market] 无法启动 dsh：${error.message}\n` });
    emitJob(job, { type: 'end', status: 'error', code: -1 });
    if (runningJobId === job.id) runningJobId = null;
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    job.code = code;
    job.status = code === 0 ? 'success' : 'error';
    job.endedAt = Date.now();
    emitJob(job, { type: 'end', status: job.status, code });
    if (runningJobId === job.id) runningJobId = null;
  });
}

function serveJobEvents(req, res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  for (const event of job.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  if (job.status !== 'running') {
    res.end();
    return;
  }
  job.listeners.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {}
  }, 15000);
  const close = () => {
    clearInterval(heartbeat);
    job.listeners.delete(res);
  };
  req.on('close', close);
  req.on('error', close);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const gzipCache = new Map();

function serveStatic(req, res, pathname) {
  let relative = decodeURIComponent(pathname);
  if (relative === '/' || relative === '') relative = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return text(res, 403, 'forbidden');
  }
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) return text(res, 404, 'not found');
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = fileEtag(stat);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    const headers = {
      'Content-Type': type,
      ETag: etag,
      'Cache-Control': ['.html', '.js', '.css', '.json'].includes(ext) ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    };
    if (type.startsWith('image/') || ext === '.woff2') headers['Cache-Control'] = 'public, max-age=604800, immutable';

    const acceptsGzip = /gzip/i.test(String(req.headers['accept-encoding'] || ''));
    if (acceptsGzip && ext === '.json') {
      const cached = gzipCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = cached.body.length;
        headers.Vary = 'Accept-Encoding';
        res.writeHead(200, headers);
        return res.end(cached.body);
      }
      fs.readFile(filePath, (readError, raw) => {
        if (readError) return text(res, 500, 'read failed');
        const body = zlib.gzipSync(raw, { level: 6 });
        gzipCache.set(filePath, { body, mtimeMs: stat.mtimeMs });
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = body.length;
        headers.Vary = 'Accept-Encoding';
        res.writeHead(200, headers);
        res.end(body);
      });
      return;
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = requestUrl.pathname;

  try {
    if (pathname === '/api/health') {
      return json(res, 200, { ok: true, uptime: process.uptime(), catalog: catalog.plugins.length });
    }

    if (pathname === '/api/catalog' && req.method === 'GET') {
      await refreshCatalog(requestUrl.searchParams.get('refresh') === '1');
      return json(res, 200, {
        ...catalog,
        live: live.source === 'live',
        liveError: live.error,
        refreshedAt: live.fetchedAt || null,
      });
    }

    if (pathname === '/api/installed' && req.method === 'GET') {
      const info = readProfiles();
      const profile = info.profiles.find((item) => item.name === info.defaultProfile) || info.profiles[0];
      if (!profile?.dir) return json(res, 200, { profile: null, names: [], specs: [], bundles: [] });
      return json(res, 200, { profile: profile.name, ...collectInstalled(profile.dir) });
    }

    if (pathname === '/api/config' && req.method === 'GET') {
      const info = readProfiles();
      return json(res, 200, {
        ...info,
        dshVersion: DSH_VERSION,
        installRunning: runningJobId,
        catalog: catalog.stats,
        catalogUpdated: catalog.stats.updated,
        catalogLive: live.source === 'live',
        source: 'https://github.com/topics/dsh-plugin',
      });
    }

    if (pathname === '/api/image' && req.method === 'GET') {
      return serveImage(req, res, requestUrl);
    }

    if (pathname === '/api/uninstall' && req.method === 'POST') {
      if (req.headers['x-dsh-market'] !== 'install') {
        return json(res, 403, { error: '缺少卸载请求标记' });
      }
      if (runningJobId) {
        const running = jobs.get(runningJobId);
        return json(res, 409, { error: '另一个操作正在进行中', jobId: runningJobId, plugin: running?.pluginName });
      }
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
      const plugin = pluginById.get(String(body.id || ''));
      if (!plugin) return json(res, 404, { error: '目录中找不到这个插件' });
      const profileName = String(body.profile || '');
      if (!/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(profileName)) {
        return json(res, 400, { error: 'profile 名称不合法' });
      }
      const info = readProfiles();
      const profile = info.profiles.find((item) => item.name === profileName);
      if (!profile?.dir || !fs.existsSync(profile.dir)) {
        return json(res, 400, { error: '目标 profile 目录不存在' });
      }
      const packageName = resolveInstalledName(collectInstalled(profile.dir), plugin);
      if (!packageName) {
        return json(res, 400, { error: '没有在这个 profile 里找到对应的已安装包' });
      }
      if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)) {
        return json(res, 400, { error: '安装包名称不合法' });
      }
      const job = createJob(plugin, profileName, 'uninstall', packageName);
      startJob(job, profile.dir);
      return json(res, 202, {
        jobId: job.id,
        command: job.command,
        profile: profileName,
        plugin: plugin.name,
        package: packageName,
      });
    }

    if (pathname === '/api/install' && req.method === 'POST') {
      const origin = String(req.headers.origin || '');
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
        return json(res, 403, { error: '只允许本机市场页面发起安装' });
      }
      if (req.headers['x-dsh-market'] !== 'install') {
        return json(res, 403, { error: '缺少安装请求标记' });
      }
      if (runningJobId) {
        const running = jobs.get(runningJobId);
        return json(res, 409, { error: '另一个安装正在进行中', jobId: runningJobId, plugin: running?.pluginName });
      }
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
      const plugin = pluginById.get(String(body.id || ''));
      if (!plugin) return json(res, 404, { error: '目录中找不到这个插件' });
      const profileName = String(body.profile || '');
      if (!/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(profileName)) {
        return json(res, 400, { error: 'profile 名称不合法' });
      }
      const info = readProfiles();
      const profile = info.profiles.find((item) => item.name === profileName);
      if (!profile && profileName !== 'web') return json(res, 400, { error: '目标 profile 不存在' });
      if (!safeSpec(plugin.spec)) {
        return json(res, 400, { error: '该插件的安装参数未通过安全检查', spec: plugin.spec });
      }
      const job = createJob(plugin, profileName);
      startJob(job, profile?.dir);
      return json(res, 202, {
        jobId: job.id,
        command: job.command,
        profile: profileName,
        plugin: plugin.name,
      });
    }

    const installMatch = pathname.match(/^\/api\/install\/([a-f0-9]+)(\/events)?$/);
    if (installMatch) {
      const job = jobs.get(installMatch[1]);
      if (!job) return json(res, 404, { error: '安装任务不存在或已过期' });
      if (installMatch[2]) return serveJobEvents(req, res, job);
      return json(res, 200, {
        id: job.id,
        status: job.status,
        code: job.code,
        plugin: job.pluginName,
        profile: job.profile,
        command: job.command,
        output: job.output,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
      });
    }

    if (pathname.startsWith('/api/')) {
      return json(res, 404, { error: 'unknown api' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return text(res, 405, 'method not allowed');
    }

    return serveStatic(req, res, pathname);
  } catch (error) {
    console.error('[market] request failed:', error);
    if (!res.headersSent) return json(res, 500, { error: 'internal error' });
    try {
      res.end();
    } catch (_) {}
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[market] 端口 ${PORT} 已被占用，请设置 PORT 后重试。`);
  } else {
    console.error('[market] server error:', error);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  DSH 插件市场');
  console.log(`  ➜  http://${HOST}:${PORT}`);
  console.log(`  ➜  dsh: ${DSH_BIN}${DSH_VERSION ? ` (${DSH_VERSION})` : ''}`);
  console.log(`  ➜  profiles: ${readProfiles().profiles.map((profile) => profile.name).join(', ') || 'none'}`);
  console.log('');
  refreshCatalog().catch((error) => console.warn('[market] 初始目录同步失败：', error.message));
  const timer = setInterval(() => {
    refreshCatalog(true).catch((error) => console.warn('[market] 目录同步失败：', error.message));
  }, LIVE_TTL);
  timer.unref();
});

process.on('SIGINT', () => {
  if (runningJobId) {
    const job = jobs.get(runningJobId);
    try {
      if (job?.child?.pid) spawnSync('taskkill', ['/pid', String(job.child.pid), '/t', '/f'], { windowsHide: true });
    } catch (_) {}
  }
  server.close(() => process.exit(0));
});

