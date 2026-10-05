#!/usr/bin/env node
import express from 'express';
import cookieSession from 'cookie-session';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8088);
const BASE = (process.env.BASE_PATH || '/recordings').replace(/\/$/, '') || '';
const DATA_DIR = process.env.DATA_DIR || '/data';
const PASSWORD_FILE = process.env.PASSWORD_FILE || '/run/secrets/recordings-password';
const LOGO_FILE = process.env.LOGO_FILE || '/branding/mindful-logo.png';
const FAVICON_FILE = process.env.FAVICON_FILE || '/branding/mindful-favicon.png';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SHARES_FILE = process.env.SHARES_FILE || path.join(DATA_DIR, '.shares.json');
const AUDIT_FILE = process.env.AUDIT_FILE || path.join(DATA_DIR, '.audit.log');
const TRASH_DIR = path.join(DATA_DIR, '.trash');
const TRASH_TTL_MS = Number(process.env.TRASH_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const JIBRI_HEALTH_URL =
  process.env.JIBRI_HEALTH_URL || 'http://jibri:2222/jibri/api/v1.0/health';
const TZ = 'Europe/London';
const ALLOWED_EXPIRY_DAYS = new Set([7, 30, 90]);
const TRASH_META = '.trash-meta.json';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(
  cookieSession({
    name: 'mr_sess',
    keys: [SESSION_SECRET],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === '0' ? false : undefined,
    sameSite: 'lax',
    path: BASE || '/',
  })
);

function readPassword() {
  try {
    return fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function requireAuth(req, res, next) {
  if (req.session?.authed) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return res.redirect(`${BASE}/login`);
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

function audit(action, details = {}, req = null) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    action,
    user: 'admin',
    ip: req ? clientIp(req) : null,
    ...details,
  });
  try {
    fs.appendFileSync(AUDIT_FILE, line + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(AUDIT_FILE, 0o600);
    } catch {
      /* ignore */
    }
  } catch (e) {
    console.error('audit write failed', e.message);
  }
}

function titleCaseRoom(slug) {
  let s = decodeURIComponent(slug || '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase();
  // guyandmani → guy and mani
  s = s.replace(/([a-z])and([a-z])/g, '$1 and $2');
  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length) return 'Recording';
  return words
    .map((w, i) => (w === 'and' && i > 0 ? 'and' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function roomFromMetadata(meta) {
  const url = meta?.meeting_url || '';
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'recording';
  } catch {
    return 'recording';
  }
}

function formatDisplayDate(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatFileStamp(date) {
  // UTC — matches Jibri filename stamps and finalize (date -u).
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}_${get('hour')}${get('minute')}`;
}

function sanitizeFilename(roomTitle, date) {
  const base = roomTitle.replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-');
  return `${base || 'Recording'}_${formatFileStamp(date)}.mp4`;
}

function parseStampFromFilename(name) {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})[_-](\d{2})-?(\d{2})(?:-?(\d{2}))?/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ensureTrashDir() {
  if (!fs.existsSync(TRASH_DIR)) {
    fs.mkdirSync(TRASH_DIR, { recursive: true, mode: 0o700 });
  }
}

function isSafeSegment(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length < 200 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('\0') &&
    name === path.basename(name) &&
    !name.startsWith('.')
  );
}

function listRecordings() {
  if (!fs.existsSync(DATA_DIR)) return [];
  const items = [];
  for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue; // skip .trash and hidden
    const dir = path.join(DATA_DIR, entry.name);
    let meta = {};
    const metaPath = path.join(dir, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch {
        meta = {};
      }
    }
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp4'));
    for (const file of files) {
      const full = path.join(dir, file);
      const st = fs.statSync(full);
      const roomSlug = roomFromMetadata(meta);
      const roomTitle = titleCaseRoom(roomSlug);
      const recordedAt = parseStampFromFilename(file) || st.mtime;
      // Title is room only; clients format recordedAt in the viewer's local timezone.
      const title = roomTitle;
      const downloadName = sanitizeFilename(roomTitle, recordedAt);
      const id = `${entry.name}/${file}`;
      items.push({
        id,
        folder: entry.name,
        filename: file,
        room: roomSlug,
        roomTitle,
        title,
        downloadName,
        recordedAt: recordedAt.toISOString(),
        size: st.size,
        meetingUrl: meta.meeting_url || null,
        streamUrl: `${BASE}/api/raw/${encodeURIComponent(entry.name)}/${encodeURIComponent(file)}`,
        downloadUrl: `${BASE}/api/raw/${encodeURIComponent(entry.name)}/${encodeURIComponent(file)}?download=1`,
      });
    }
  }
  items.sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));
  return items;
}

function resolveRaw(folder, file) {
  if (!isSafeSegment(folder) || !isSafeSegment(file)) return null;
  const safeFolder = path.basename(folder);
  const safeFile = path.basename(file);
  if (!safeFile.toLowerCase().endsWith('.mp4')) return null;
  const full = path.join(DATA_DIR, safeFolder, safeFile);
  const resolved = path.resolve(full);
  const dataRoot = path.resolve(DATA_DIR) + path.sep;
  if (!resolved.startsWith(dataRoot)) return null;
  if (resolved.includes(`${path.sep}.trash${path.sep}`)) return null;
  if (!fs.existsSync(resolved)) return null;
  return { full: resolved, folder: safeFolder, file: safeFile };
}

function resolveTrashFolder(trashName) {
  if (!isSafeSegment(trashName)) return null;
  const full = path.join(TRASH_DIR, path.basename(trashName));
  const resolved = path.resolve(full);
  const trashRoot = path.resolve(TRASH_DIR) + path.sep;
  if (!resolved.startsWith(trashRoot)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return null;
  return { full: resolved, name: path.basename(trashName) };
}

function loadShares() {
  try {
    const raw = fs.readFileSync(SHARES_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}

function saveShares(shares) {
  const dir = path.dirname(SHARES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${SHARES_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(shares, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, SHARES_FILE);
  try {
    fs.chmodSync(SHARES_FILE, 0o600);
  } catch {
    /* ignore */
  }
}

function revokeSharesForRecording(recordingId, folder) {
  const shares = loadShares();
  let removed = 0;
  for (const [token, entry] of Object.entries(shares)) {
    const sid = entry?.id || '';
    if (sid === recordingId || sid.startsWith(`${folder}/`)) {
      delete shares[token];
      removed += 1;
    }
  }
  if (removed) saveShares(shares);
  return removed;
}

function isShareActive(entry) {
  if (!entry || !entry.expiresAt) return false;
  const exp = new Date(entry.expiresAt).getTime();
  return Number.isFinite(exp) && exp > Date.now();
}

function getActiveShare(token) {
  if (!token || typeof token !== 'string') return null;
  const shares = loadShares();
  const entry = shares[token];
  if (!isShareActive(entry)) return null;
  return { token, ...entry };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJibriHealth() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(JIBRI_HEALTH_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * True if this session folder looks like an in-progress Jibri recording.
 * Jibri HTTP API often binds localhost-only, so we combine optional health
 * with a filesystem growth check on the session directory.
 */
async function isSessionRecordingBusy(folder) {
  if (!isSafeSegment(folder)) return false;
  const dir = path.join(DATA_DIR, folder);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;

  let healthBusy = false;
  const health = await fetchJibriHealth();
  const busy = health?.status?.busyStatus || health?.busyStatus;
  if (busy === 'BUSY') healthBusy = true;

  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  if (!files.length) return healthBusy;

  const snapshots = [];
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(dir, f));
      snapshots.push({ f, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* ignore */
    }
  }
  const recent = snapshots.some((s) => Date.now() - s.mtimeMs < 12000);
  if (!recent && !healthBusy) return false;

  await sleep(1200);
  for (const s of snapshots) {
    try {
      const st = fs.statSync(path.join(dir, s.f));
      if (st.size > s.size) return true; // actively growing → recording
    } catch {
      /* file vanished */
    }
  }
  // Health says BUSY and this folder was touched very recently
  if (healthBusy && recent) return true;
  return false;
}

function daysLeft(deletedAtIso, nowMs = Date.now()) {
  const deleted = new Date(deletedAtIso).getTime();
  if (!Number.isFinite(deleted)) return 0;
  const left = TRASH_TTL_MS - (nowMs - deleted);
  return Math.max(0, Math.ceil(left / (24 * 60 * 60 * 1000)));
}

function listBin(nowMs = Date.now()) {
  ensureTrashDir();
  const items = [];
  for (const entry of fs.readdirSync(TRASH_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSafeSegment(entry.name)) continue;
    const dir = path.join(TRASH_DIR, entry.name);
    let meta = {};
    const metaPath = path.join(dir, TRASH_META);
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch {
        meta = {};
      }
    }
    const deletedAt = meta.deletedAt || fs.statSync(dir).mtime.toISOString();
    const left = daysLeft(deletedAt, nowMs);
    if (left <= 0 && meta.deletedAt) {
      // still list until purge runs; mark 0
    }
    items.push({
      trashId: entry.name,
      id: meta.id || `${entry.name}/${meta.filename || ''}`,
      folder: meta.folder || entry.name,
      filename: meta.filename || null,
      title: meta.title || meta.roomTitle || entry.name,
      roomTitle: meta.roomTitle || meta.title || '',
      size: meta.size || 0,
      recordedAt: meta.recordedAt || null,
      deletedAt,
      daysLeft: left,
      expiresAt: new Date(new Date(deletedAt).getTime() + TRASH_TTL_MS).toISOString(),
    });
  }
  items.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
  return items;
}

function rmRecursive(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

async function softDeleteRecording(id, req) {
  const slash = id.indexOf('/');
  if (slash <= 0) {
    const err = new Error('invalid_id');
    err.code = 'invalid_id';
    err.status = 400;
    throw err;
  }
  const folder = id.slice(0, slash);
  const file = id.slice(slash + 1);
  const resolved = resolveRaw(folder, file);
  if (!resolved) {
    const err = new Error('not_found');
    err.code = 'not_found';
    err.status = 404;
    throw err;
  }

  if (await isSessionRecordingBusy(resolved.folder)) {
    const err = new Error('jibri_busy');
    err.code = 'jibri_busy';
    err.status = 409;
    throw err;
  }

  const items = listRecordings();
  const recording = items.find((i) => i.id === id);
  if (!recording) {
    const err = new Error('not_found');
    err.code = 'not_found';
    err.status = 404;
    throw err;
  }

  ensureTrashDir();
  let trashName = resolved.folder;
  let dest = path.join(TRASH_DIR, trashName);
  if (fs.existsSync(dest)) {
    trashName = `${resolved.folder}-${Date.now()}`;
    if (!isSafeSegment(trashName)) {
      trashName = `trash-${Date.now()}`;
    }
    dest = path.join(TRASH_DIR, trashName);
  }

  const srcDir = path.join(DATA_DIR, resolved.folder);
  const trashMeta = {
    id: recording.id,
    folder: resolved.folder,
    filename: resolved.file,
    title: recording.title,
    roomTitle: recording.roomTitle,
    size: recording.size,
    recordedAt: recording.recordedAt,
    deletedAt: new Date().toISOString(),
    meetingUrl: recording.meetingUrl,
  };

  fs.renameSync(srcDir, dest);
  fs.writeFileSync(path.join(dest, TRASH_META), JSON.stringify(trashMeta, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });

  const sharesRemoved = revokeSharesForRecording(id, resolved.folder);
  audit(
    'delete',
    {
      id: recording.id,
      folder: resolved.folder,
      filename: resolved.file,
      title: recording.title,
      size: recording.size,
      trashId: trashName,
      sharesRemoved,
    },
    req
  );

  return { trashId: trashName, ...trashMeta, daysLeft: daysLeft(trashMeta.deletedAt) };
}

function restoreFromBin(trashId, req) {
  const resolved = resolveTrashFolder(trashId);
  if (!resolved) {
    const err = new Error('not_found');
    err.code = 'not_found';
    err.status = 404;
    throw err;
  }

  let meta = {};
  const metaPath = path.join(resolved.full, TRASH_META);
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      meta = {};
    }
  }

  const destFolder = isSafeSegment(meta.folder) ? meta.folder : resolved.name;
  const dest = path.join(DATA_DIR, destFolder);
  if (fs.existsSync(dest)) {
    const err = new Error('conflict');
    err.code = 'conflict';
    err.status = 409;
    throw err;
  }

  // Remove trash meta before moving back so library does not see it
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  fs.renameSync(resolved.full, dest);

  audit(
    'restore',
    {
      trashId,
      id: meta.id || null,
      folder: destFolder,
      filename: meta.filename || null,
      title: meta.title || null,
      size: meta.size || null,
    },
    req
  );

  return { folder: destFolder, id: meta.id || null };
}

function purgeExpired(nowMs = Date.now(), req = null) {
  ensureTrashDir();
  const purged = [];
  for (const entry of fs.readdirSync(TRASH_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSafeSegment(entry.name)) continue;
    const dir = path.join(TRASH_DIR, entry.name);
    let deletedAt = fs.statSync(dir).mtimeMs;
    let meta = {};
    const metaPath = path.join(dir, TRASH_META);
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.deletedAt) deletedAt = new Date(meta.deletedAt).getTime();
      } catch {
        /* ignore */
      }
    }
    if (!Number.isFinite(deletedAt)) continue;
    if (nowMs - deletedAt < TRASH_TTL_MS) continue;

    rmRecursive(dir);
    purged.push({
      trashId: entry.name,
      id: meta.id || null,
      title: meta.title || null,
    });
    audit(
      'purge',
      {
        trashId: entry.name,
        id: meta.id || null,
        title: meta.title || null,
        size: meta.size || null,
        deletedAt: meta.deletedAt || null,
      },
      req
    );
  }
  return purged;
}

function streamMp4(req, res, fullPath, downloadName, asDownload) {
  const st = fs.statSync(fullPath);
  const safeName = String(downloadName || 'recording.mp4').replace(/"/g, '');
  if (asDownload) {
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  } else {
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) {
      res.status(416).end();
      return;
    }
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : st.size - 1;
    if (start >= st.size || end >= st.size || start > end) {
      res.status(416).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', end - start + 1);
    return fs.createReadStream(fullPath, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', st.size);
  fs.createReadStream(fullPath).pipe(res);
}

const router = express.Router();

router.get('/api/health', (_req, res) => res.json({ ok: true }));

router.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const expected = readPassword();
  if (!expected) return res.status(500).json({ error: 'password_not_configured' });
  if (username !== 'admin' || password !== expected) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  req.session.authed = true;
  req.session.user = 'admin';
  return res.json({ ok: true });
});

router.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/api/me', (req, res) => {
  if (!req.session?.authed) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: 'admin', trashTtlDays: Math.round(TRASH_TTL_MS / (24 * 60 * 60 * 1000)) });
});

router.get('/api/recordings', requireAuth, (_req, res) => {
  res.json({ items: listRecordings() });
});

router.delete('/api/recordings/:folder/:file', requireAuth, async (req, res) => {
  try {
    const id = `${req.params.folder}/${req.params.file}`;
    const result = await softDeleteRecording(id, req);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.code || e.message || 'error' });
  }
});

router.get('/api/bin', requireAuth, (_req, res) => {
  purgeExpired(); // opportunistic
  res.json({
    items: listBin(),
    ttlDays: Math.round(TRASH_TTL_MS / (24 * 60 * 60 * 1000)),
  });
});

router.post('/api/bin/:trashId/restore', requireAuth, (req, res) => {
  try {
    const result = restoreFromBin(req.params.trashId, req);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.code || e.message || 'error' });
  }
});

router.post('/api/bin/purge', requireAuth, (req, res) => {
  let nowMs = Date.now();
  // Admin test hook: force clock for expiry simulation
  if (req.body?.now) {
    const t = new Date(req.body.now).getTime();
    if (!Number.isFinite(t)) return res.status(400).json({ error: 'invalid_now' });
    nowMs = t;
  }
  const purged = purgeExpired(nowMs, req);
  return res.json({ ok: true, purged, count: purged.length });
});

router.post('/api/shares', requireAuth, (req, res) => {
  const id = String(req.body?.id || '').trim();
  const expiresInDays = Number(req.body?.expiresInDays ?? 30);
  const allowDownload = Boolean(req.body?.allowDownload);

  if (!id) return res.status(400).json({ error: 'id_required' });
  if (!ALLOWED_EXPIRY_DAYS.has(expiresInDays)) {
    return res.status(400).json({ error: 'invalid_expiresInDays' });
  }

  const items = listRecordings();
  const recording = items.find((i) => i.id === id);
  if (!recording) return res.status(404).json({ error: 'not_found' });

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const shares = loadShares();
  shares[token] = {
    id,
    expiresAt,
    allowDownload,
    createdAt: new Date().toISOString(),
  };
  saveShares(shares);

  const url = `${BASE}/s/${token}`;
  return res.status(201).json({ token, url, expiresAt, allowDownload });
});

router.get('/api/shares', requireAuth, (req, res) => {
  const recordingId = String(req.query.recordingId || '').trim();
  if (!recordingId) return res.status(400).json({ error: 'recordingId_required' });

  const shares = loadShares();
  const items = [];
  for (const [token, entry] of Object.entries(shares)) {
    if (entry?.id !== recordingId) continue;
    if (!isShareActive(entry)) continue;
    items.push({
      token,
      url: `${BASE}/s/${token}`,
      expiresAt: entry.expiresAt,
      allowDownload: Boolean(entry.allowDownload),
      createdAt: entry.createdAt || null,
    });
  }
  items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json({ items });
});

router.delete('/api/shares/:token', requireAuth, (req, res) => {
  const token = String(req.params.token || '');
  const shares = loadShares();
  if (!Object.prototype.hasOwnProperty.call(shares, token)) {
    return res.status(404).json({ error: 'not_found' });
  }
  delete shares[token];
  saveShares(shares);
  return res.status(204).end();
});

router.get('/api/share/:token', (req, res) => {
  const share = getActiveShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'not_found' });

  const items = listRecordings();
  const recording = items.find((i) => i.id === share.id);
  if (!recording) return res.status(404).json({ error: 'not_found' });

  const allowDownload = Boolean(share.allowDownload);
  const payload = {
    title: recording.title,
    roomTitle: recording.roomTitle,
    recordedAt: recording.recordedAt,
    size: recording.size,
    streamUrl: `${BASE}/api/share/${share.token}/raw`,
    expiresAt: share.expiresAt,
    allowDownload,
  };
  if (allowDownload) {
    payload.downloadUrl = `${BASE}/api/share/${share.token}/raw?download=1`;
  }
  return res.json(payload);
});

router.get('/api/share/:token/raw', (req, res) => {
  const share = getActiveShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'not_found' });

  const slash = share.id.indexOf('/');
  if (slash <= 0) return res.status(404).json({ error: 'not_found' });
  const folder = share.id.slice(0, slash);
  const file = share.id.slice(slash + 1);
  const resolved = resolveRaw(folder, file);
  if (!resolved) return res.status(404).json({ error: 'not_found' });

  const items = listRecordings();
  const match = items.find((i) => i.folder === resolved.folder && i.filename === resolved.file);
  const downloadName = match?.downloadName || resolved.file;
  const asDownload = Boolean(req.query.download) && Boolean(share.allowDownload);
  if (req.query.download && !share.allowDownload) {
    return res.status(404).json({ error: 'not_found' });
  }

  return streamMp4(req, res, resolved.full, downloadName, asDownload);
});

router.get('/api/raw/:folder/:file', requireAuth, (req, res) => {
  const resolved = resolveRaw(req.params.folder, req.params.file);
  if (!resolved) return res.status(404).json({ error: 'not_found' });

  const items = listRecordings();
  const match = items.find((i) => i.folder === resolved.folder && i.filename === resolved.file);
  const downloadName = match?.downloadName || resolved.file;
  return streamMp4(req, res, resolved.full, downloadName, Boolean(req.query.download));
});

router.get('/assets/logo.png', (_req, res) => {
  if (fs.existsSync(LOGO_FILE)) return res.sendFile(LOGO_FILE);
  res.status(404).end();
});

router.get('/assets/favicon.png', (_req, res) => {
  if (fs.existsSync(FAVICON_FILE)) return res.sendFile(FAVICON_FILE);
  if (fs.existsSync(LOGO_FILE)) return res.sendFile(LOGO_FILE);
  res.status(404).end();
});

router.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));

router.get(['/', '/login', '/watch', '/bin', '/s', '/s/:token'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(BASE || '/', router);
if (BASE) {
  app.get('/', (_req, res) => res.redirect(BASE + '/'));
}

ensureTrashDir();
purgeExpired();
setInterval(() => {
  try {
    purgeExpired();
  } catch (e) {
    console.error('purge error', e.message);
  }
}, 60 * 60 * 1000).unref?.();

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Mindful Recordings listening on :${PORT} base=${BASE || '/'} shares=${SHARES_FILE} trashTtlDays=${Math.round(TRASH_TTL_MS / 86400000)}`
  );
});
