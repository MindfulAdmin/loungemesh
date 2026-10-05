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
const TZ = 'Europe/London';
const ALLOWED_EXPIRY_DAYS = new Set([7, 30, 90]);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(
  cookieSession({
    name: 'mr_sess',
    keys: [SESSION_SECRET],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    // Respect X-Forwarded-Proto from Caddy (trust proxy above)
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

function titleCaseRoom(slug) {
  return decodeURIComponent(slug)
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'Recording';
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
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
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

function listRecordings() {
  if (!fs.existsSync(DATA_DIR)) return [];
  const items = [];
  for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
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
      const recordedAt =
        parseStampFromFilename(file) || st.mtime;
      const title = `${roomTitle} · ${formatDisplayDate(recordedAt)}`;
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
  const safeFolder = path.basename(folder);
  const safeFile = path.basename(file);
  if (!safeFile.toLowerCase().endsWith('.mp4')) return null;
  const full = path.join(DATA_DIR, safeFolder, safeFile);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(DATA_DIR) + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;
  return { full: resolved, folder: safeFolder, file: safeFile };
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
    // best-effort on filesystems that ignore mode
  }
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
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (start >= st.size || end >= st.size) {
        res.status(416).setHeader('Content-Range', `bytes */${st.size}`);
        return res.end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(fullPath, { start, end }).pipe(res);
    }
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
  res.json({ user: 'admin' });
});

router.get('/api/recordings', requireAuth, (_req, res) => {
  res.json({ items: listRecordings() });
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

router.get(['/', '/login', '/watch', '/s', '/s/:token'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(BASE || '/', router);
if (!BASE) {
  // already mounted at /
} else {
  app.get('/', (_req, res) => res.redirect(BASE + '/'));
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mindful Recordings listening on :${PORT} base=${BASE || '/'} shares=${SHARES_FILE}`);
});
