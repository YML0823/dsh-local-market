/**
 * dsh-local-market host entry.
 *
 * Serves the embedded market UI below /dsh-local-market/ and exposes the
 * small loopback API it needs: profile detection, screenshot proxying, and
 * install jobs backed by the local `dsh plugin` CLI.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import catalogLib from './lib/catalog.cjs';

export const name = 'dsh-local-market';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, 'ui');
const DATA_FILE = path.join(UI_DIR, 'data', 'plugins.json');
const PREFIX = '/dsh-local-market';
const IMAGE_CACHE = path.join(os.tmpdir(), 'dsh-local-market-images');
const MAX_BODY = 64 * 1024;
const MAX_IMAGE = 16 * 1024 * 1024;
const INSTALL_TIMEOUT = 12 * 60 * 1000;
const LIVE_URL = 'https://awesome-dsh-plugin.com/plugins.json';
const LIVE_TTL = 10 * 60 * 1000;

fs.mkdirSync(IMAGE_CACHE, { recursive: true });

let catalog = { plugins: [], categories: [], stats: {}, featured: catalogLib.FEATURED };
try {
  catalog = { ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')), featured: catalogLib.FEATURED };
} catch (error) {
  console.error('[dsh-local-market] 无法读取目录数据：', error.message);
}
let pluginById = new Map((catalog.plugins || []).map((plugin) => [plugin.id, plugin]));
let live = { source: 'snapshot', fetchedAt: 0, error: null, pending: null };

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
      const next = catalogLib.normalizeCatalog(raw);
      catalog = next;
      pluginById = new Map(next.plugins.map((plugin) => [plugin.id, plugin]));
      live = { source: 'live', fetchedAt: Date.now(), error: null, pending: null };
    } catch (error) {
      live.error = error.message;
      live.source = 'snapshot';
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

const gzipCache = new Map();

function readProfiles() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const dir = path.join(home, 'profiles');
  const profiles = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const profileDir = path.join(dir, entry.name);
      let pkg = null;
      try {
        pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
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
  const argv = process.argv;
  const flag = argv.indexOf('--profile');
  const argvProfile = flag !== -1 && argv[flag + 1] && !argv[flag + 1].startsWith('-') ? argv[flag + 1] : '';
  const envProfile = process.env.DSH_PROFILE || '';
  const wanted = [envProfile, argvProfile].find((item) => profiles.some((profile) => profile.name === item));
  const defaultProfile = wanted || profiles.find((profile) => profile.managed)?.name || profiles[0]?.name || 'web';
  return { profiles, defaultProfile, profilesDir: dir };
}

let dshBinCache;
function findDsh() {
  if (dshBinCache) return dshBinCache;
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) {
    dshBinCache = process.env.DSH_BIN;
    return dshBinCache;
  }
  try {
    const result = spawnSync('where.exe', ['dsh'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const lines = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const cmd = lines.find((line) => /\.cmd$/i.test(line)) || lines[0];
    if (cmd && fs.existsSync(cmd)) {
      dshBinCache = cmd;
      return dshBinCache;
    }
  } catch (_) {}
  dshBinCache = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
  return dshBinCache;
}

let versionState;
function dshVersion() {
  if (versionState !== undefined) return versionState;
  try {
    const result = spawnSync(`"${findDsh().replace(/"/g, '""')}" --version`, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 12000,
      shell: true,
    });
    versionState = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null;
  } catch (_) {
    versionState = null;
  }
  return versionState;
}

function sendJson(response, status, body) {
  const raw = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': raw.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(raw);
}

function sendText(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        reject(new Error('invalid JSON body'));
      }
    });
    request.on('error', reject);
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

// ---------------------------------------------------------------------------
// Image proxy
// ---------------------------------------------------------------------------
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

async function serveImage(request, response, requestUrl) {
  const target = requestUrl.searchParams.get('u');
  if (!target) return sendText(response, 400, 'missing image url');
  let url;
  try {
    url = new URL(target).href;
  } catch (_) {
    return sendText(response, 400, 'invalid image url');
  }
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  const cacheFile = path.join(IMAGE_CACHE, hash);
  const metaFile = `${cacheFile}.json`;
  try {
    const [buffer, metaRaw] = await Promise.all([fsp.readFile(cacheFile), fsp.readFile(metaFile, 'utf8')]);
    const meta = JSON.parse(metaRaw);
    response.writeHead(200, {
      'Content-Type': meta.type || 'image/png',
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(buffer);
    return;
  } catch (_) {}
  try {
    const { buffer, type } = await fetchImage(url);
    await Promise.all([
      fsp.writeFile(cacheFile, buffer),
      fsp.writeFile(metaFile, JSON.stringify({ type, url, savedAt: new Date().toISOString() })),
    ]);
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(buffer);
  } catch (error) {
    sendText(response, 502, `image unavailable: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Install jobs
// ---------------------------------------------------------------------------
const jobs = new Map();
let runningJobId = null;

function createJob(plugin, profile) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id,
    pluginId: plugin.id,
    pluginName: plugin.name,
    profile,
    command: `${quoteCmd(findDsh())} plugin --profile ${quoteCmd(profile)} add ${quoteCmd(plugin.spec)}`,
    status: 'running',
    code: null,
    output: '',
    events: [],
    listeners: new Set(),
    child: null,
    startedAt: Date.now(),
    endedAt: null,
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
    cwd: profileDir && fs.existsSync(profileDir) ? profileDir : HERE,
    shell: true,
    windowsHide: true,
    env: { ...process.env, CI: process.env.CI || '1', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  job.child = child;
  runningJobId = job.id;
  emitJob(job, { type: 'start', command: job.command, plugin: job.pluginName, profile: job.profile });

  const onData = (chunk) => {
    const value = cleanAnsi(chunk.toString('utf8'));
    job.output = (job.output + value).slice(-120000);
    emitJob(job, { type: 'log', text: value });
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

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

function serveJobEvents(request, response, job) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.write('retry: 1500\n\n');
  for (const event of job.events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  if (job.status !== 'running') {
    response.end();
    return;
  }
  job.listeners.add(response);
  const heartbeat = setInterval(() => {
    try {
      response.write(': ping\n\n');
    } catch (_) {}
  }, 15000);
  const close = () => {
    clearInterval(heartbeat);
    job.listeners.delete(response);
  };
  request.on('close', close);
  request.on('error', close);
}

// ---------------------------------------------------------------------------
// Static files and API
// ---------------------------------------------------------------------------
function fileEtag(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

async function serveStatic(request, response, subPath) {
  let relative = decodeURIComponent(subPath || '/');
  if (relative === '/' || relative === '') relative = '/index.html';
  if (relative.endsWith('/')) relative += 'index.html';
  const filePath = path.resolve(UI_DIR, `.${relative}`);
  if (!filePath.startsWith(UI_DIR + path.sep)) return sendText(response, 403, 'forbidden');
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (_) {
    return sendText(response, 404, 'not found');
  }
  if (!stat.isFile()) return sendText(response, 404, 'not found');
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    ETag: fileEtag(stat),
    'Cache-Control': ['.html', '.js', '.css', '.json'].includes(ext) ? 'no-cache' : 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  };
  if (request.headers['if-none-match'] === headers.ETag) {
    response.writeHead(304, { ETag: headers.ETag });
    response.end();
    return;
  }
  let body;
  if (ext === '.json' && /gzip/i.test(String(request.headers['accept-encoding'] || ''))) {
    const cached = gzipCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      body = cached.body;
    } else {
      body = zlib.gzipSync(await fsp.readFile(filePath), { level: 6 });
      gzipCache.set(filePath, { body, mtimeMs: stat.mtimeMs });
    }
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  } else {
    body = await fsp.readFile(filePath);
  }
  headers['Content-Length'] = body.length;
  response.writeHead(200, headers);
  if (request.method === 'HEAD') response.end();
  else response.end(body);
}

async function handleApi(request, response, requestUrl, subPath) {
  const apiPath = subPath.slice('/api'.length) || '/';

  if (apiPath === '/config' && request.method === 'GET') {
    const info = readProfiles();
    return sendJson(response, 200, {
      ...info,
      embedded: true,
      dshVersion: dshVersion(),
      installRunning: runningJobId,
      catalog: catalog.stats,
      catalogUpdated: catalog.stats.updated,
      catalogLive: live.source === 'live',
      source: 'https://github.com/topics/dsh-plugin',
    });
  }

  if (apiPath === '/catalog' && request.method === 'GET') {
    const refreshed = requestUrl.searchParams.get('refresh') === '1';
    await refreshCatalog(refreshed);
    return sendJson(response, 200, {
      ...catalog,
      live: live.source === 'live',
      liveError: live.error,
      refreshedAt: live.fetchedAt || null,
    });
  }

  if (apiPath === '/image' && request.method === 'GET') {
    return serveImage(request, response, requestUrl);
  }

  if (apiPath === '/install' && request.method === 'POST') {
    if (request.headers['x-dsh-market'] !== 'install') {
      return sendJson(response, 403, { error: '缺少安装请求标记' });
    }
    if (runningJobId) {
      const running = jobs.get(runningJobId);
      return sendJson(response, 409, { error: '另一个安装正在进行中', jobId: runningJobId, plugin: running?.pluginName });
    }
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
    const plugin = pluginById.get(String(body.id || ''));
    if (!plugin) return sendJson(response, 404, { error: '目录中找不到这个插件' });
    const profileName = String(body.profile || '');
    if (!/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(profileName)) {
      return sendJson(response, 400, { error: 'profile 名称不合法' });
    }
    const info = readProfiles();
    const profile = info.profiles.find((item) => item.name === profileName);
    if (!profile && profileName !== 'web') return sendJson(response, 400, { error: '目标 profile 不存在' });
    if (!safeSpec(plugin.spec)) {
      return sendJson(response, 400, { error: '该插件的安装参数未通过安全检查', spec: plugin.spec });
    }
    const job = createJob(plugin, profileName);
    startJob(job, profile?.dir);
    return sendJson(response, 202, {
      jobId: job.id,
      command: job.command,
      profile: profileName,
      plugin: plugin.name,
    });
  }

  const installMatch = apiPath.match(/^\/install\/([a-f0-9]+)(\/events)?$/);
  if (installMatch) {
    const job = jobs.get(installMatch[1]);
    if (!job) return sendJson(response, 404, { error: '安装任务不存在或已过期' });
    if (installMatch[2]) return serveJobEvents(request, response, job);
    return sendJson(response, 200, {
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

  return sendJson(response, 404, { error: 'unknown api' });
}

async function handle(request, response) {
  const requestUrl = new URL(request.url, 'http://localhost');
  if (requestUrl.pathname === PREFIX) {
    response.writeHead(302, { Location: `${PREFIX}/` });
    response.end();
    return;
  }
  if (!requestUrl.pathname.startsWith(`${PREFIX}/`)) {
    return sendText(response, 404, 'not found');
  }
  const subPath = requestUrl.pathname.slice(PREFIX.length);
  if (subPath.startsWith('/api/')) {
    return handleApi(request, response, requestUrl, subPath);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return sendText(response, 405, 'method not allowed');
  }
  return serveStatic(request, response, subPath);
}

export function apply(ctx) {
  ctx.inject(['webServer'], (hostCtx) => {
    const register = () => {
      try {
        return hostCtx.webServer.register({
          kind: 'prefix',
          path: PREFIX,
          handler: (request, response) => {
            Promise.resolve(handle(request, response)).catch((error) => {
              console.error('[dsh-local-market] request failed:', error);
              if (!response.headersSent) sendText(response, 500, 'internal error');
              else {
                try { response.end(); } catch (_) {}
              }
            });
          },
        });
      } catch (error) {
        console.error('[dsh-local-market] 无法注册 HTTP 路由：', error);
        return () => {};
      }
    };

    if (typeof hostCtx.effect === 'function') {
      hostCtx.effect(() => {
        const dispose = register();
        const timer = setInterval(() => {
          refreshCatalog(true).catch((error) => console.warn('[dsh-local-market] 目录同步失败：', error.message));
        }, LIVE_TTL);
        timer.unref?.();
        refreshCatalog().catch((error) => console.warn('[dsh-local-market] 初始目录同步失败：', error.message));
        return () => {
          clearInterval(timer);
          dispose?.();
          for (const job of jobs.values()) {
            if (job.status === 'running' && job.child?.pid) {
              try {
                if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(job.child.pid), '/t', '/f'], { windowsHide: true });
                else job.child.kill('SIGTERM');
              } catch (_) {}
            }
          }
        };
      }, 'dsh-local-market: http routes');
    } else {
      register();
    }
  });
}
