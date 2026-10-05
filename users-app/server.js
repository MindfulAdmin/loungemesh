#!/usr/bin/env node
import express from 'express';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import pg from 'pg';

const execFileAsync = promisify(execFile);
const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8089);
const BASE = (process.env.BASE_PATH || '/users').replace(/\/$/, '') || '';
const ADMINS_FILE = process.env.ADMINS_FILE || '/branding/users-admins.json';
const BOOTSTRAP_PASSWORD_FILE =
  process.env.BOOTSTRAP_PASSWORD_FILE || '/run/secrets/users-admin-password';
const BOOTSTRAP_ADMIN_EMAIL = (
  process.env.BOOTSTRAP_ADMIN_EMAIL || 'matt@mindfuldesign.me'
).toLowerCase();
const BOOTSTRAP_ADMIN_NAME = process.env.BOOTSTRAP_ADMIN_NAME || 'Matt';
const BAD_SECRETS = new Set([
  '',
  'change-me-users-session',
  'change-me',
  'mindful-recordings-change-me',
]);
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim();
if (!SESSION_SECRET || BAD_SECRETS.has(SESSION_SECRET) || SESSION_SECRET.length < 24) {
  console.error(
    '[users-ui] SESSION_SECRET missing or insecure. Set USERS_SESSION_SECRET in .env (≥24 chars, not a default).'
  );
  process.exit(1);
}
const PROSODY_CONTAINER = process.env.PROSODY_CONTAINER || 'loungemesh-prosody-1';
const PROSODY_DOMAIN = process.env.PROSODY_DOMAIN || 'meet.jitsi';
// Rootless Jitsi (stable-11146+): Prosody runs as uid 1000 (s6) with runtime
// config under /run/prosody/config and data_path /var/lib/prosody/data.
const PROSODY_CONFIG =
  process.env.PROSODY_CONFIG || '/run/prosody/config/prosody.cfg.lua';
const PROSODY_USER = process.env.PROSODY_USER || 's6';
const PROSODY_DATA_DIR = process.env.PROSODY_DATA_DIR || '/var/lib/prosody/data';
const PROSODY_SYSTEM_USERS = new Set(
  (process.env.PROSODY_SYSTEM_USERS || 'focus,jibri,jigasi,jvb,recorder,office')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const BCRYPT_ROUNDS = 10;
const LOGO_DARK = process.env.LOGO_DARK || '/branding/mindful-logo-dark.png';
const LOGO_WHITE = process.env.LOGO_WHITE || '/branding/mindful-logo-white.png';
const FAVICON_FILE = process.env.FAVICON_FILE || '/branding/mindful-favicon.png';

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'loungemesh',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 'loungemesh',
  max: 5,
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  next();
});
app.use(
  cookieSession({
    name: 'mu_sess',
    keys: [SESSION_SECRET],
    maxAge: SESSION_MAX_AGE_MS,
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === '0' ? false : undefined,
    sameSite: 'lax',
    path: BASE || '/',
  })
);

/** In-memory login rate limit: 10 attempts / 15 min per IP. */
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 10;

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function checkLoginRate(ip) {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now - entry.start > LOGIN_WINDOW_MS) {
    entry = { start: now, count: 0 };
    loginAttempts.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count > LOGIN_MAX) {
    const retryAfter = Math.ceil((entry.start + LOGIN_WINDOW_MS - now) / 1000);
    return { ok: false, retryAfter: Math.max(retryAfter, 1) };
  }
  return { ok: true };
}

function localPart(email) {
  const s = String(email || '');
  const i = s.indexOf('@');
  return (i > 0 ? s.slice(0, i) : s).toLowerCase();
}

/** Safe Prosody localpart — required on every Prosody path (create/reset/delete). */
const MEET_USER_RE = /^[a-z0-9._-]{1,64}$/;

function normalizeMeetUsername(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');
}

/** Returns sanitized username or null if empty/invalid charset. */
function assertSafeMeetUser(raw) {
  const user = normalizeMeetUsername(raw);
  if (!user || !MEET_USER_RE.test(user)) return null;
  return user;
}

function readBootstrapPassword() {
  try {
    return fs.readFileSync(BOOTSTRAP_PASSWORD_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function readAdmins() {
  try {
    const raw = fs.readFileSync(ADMINS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.admins) ? data.admins : [];
  } catch {
    return [];
  }
}

function fileOwnerIds() {
  const uid = Number.parseInt(process.env.FILE_OWNER_UID || '1000', 10);
  const gid = Number.parseInt(process.env.FILE_OWNER_GID || '1000', 10);
  if (!Number.isFinite(uid) || !Number.isFinite(gid) || uid < 0 || gid < 0) {
    return { uid: 1000, gid: 1000 };
  }
  return { uid, gid };
}

function writeAdmins(admins) {
  const dir = path.dirname(ADMINS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ admins }, null, 2) + '\n';
  const tmp = `${ADMINS_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, ADMINS_FILE);
  } catch {
    // Single-file Docker bind mounts reject rename (EBUSY); write in place.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    fs.writeFileSync(ADMINS_FILE, payload, { mode: 0o600 });
  }
  try {
    fs.chmodSync(ADMINS_FILE, 0o600);
  } catch {
    /* ignore */
  }
  // Container runs as root for docker.sock; hand file back to host deploy so
  // daily backups can read branding without aborting on Permission denied.
  try {
    const { uid, gid } = fileOwnerIds();
    fs.chownSync(ADMINS_FILE, uid, gid);
  } catch {
    /* ignore */
  }
}

async function ensureBootstrapAdmin() {
  const admins = readAdmins();
  if (admins.length) return;
  const password = readBootstrapPassword();
  if (!password) {
    console.warn(
      '[users-ui] No admins and no bootstrap password file; login will fail until configured.'
    );
    return;
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  writeAdmins([
    {
      email: BOOTSTRAP_ADMIN_EMAIL,
      displayName: BOOTSTRAP_ADMIN_NAME,
      passwordHash,
      createdAt: new Date().toISOString(),
    },
  ]);
  console.log(`[users-ui] Bootstrapped admin ${BOOTSTRAP_ADMIN_EMAIL}`);
}

function requireAuth(req, res, next) {
  if (req.session?.authed && req.session?.email) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return res.redirect(`${BASE}/login`);
}

function prosodyAccountsDir() {
  const encoded = PROSODY_DOMAIN.replace(/\./g, '%2e');
  return `${PROSODY_DATA_DIR.replace(/\/$/, '')}/${encoded}/accounts`;
}

function prosodyAccountRolesDir() {
  const encoded = PROSODY_DOMAIN.replace(/\./g, '%2e');
  return `${PROSODY_DATA_DIR.replace(/\/$/, '')}/${encoded}/account_roles`;
}

/** Prosody flat-file storage encodes '.' in localparts as %2e in filenames. */
function decodeProsodyLocalpart(filenameStem) {
  try {
    return decodeURIComponent(String(filenameStem || '')).toLowerCase();
  } catch {
    return String(filenameStem || '').toLowerCase();
  }
}

function encodeProsodyFilename(localpart) {
  // Match Prosody internal encoding for '.' only (common case).
  return String(localpart || '')
    .toLowerCase()
    .replace(/\./g, '%2e');
}

async function dockerExec(args, { env, user } = {}) {
  const full = ['exec'];
  const runAs = user || PROSODY_USER;
  if (runAs) {
    full.push('-u', String(runAs));
  }
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) {
      full.push('-e', `${k}=${v}`);
    }
  }
  full.push(PROSODY_CONTAINER, ...args);
  try {
    const { stdout, stderr } = await execFileAsync('docker', full, {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 15000,
    });
    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || 'docker_exec_failed',
      code: err.code,
    };
  }
}

/**
 * Password via env inside Prosody — nested docker stdin is unreliable.
 * JID/config/subcommand only via env (never interpolated into the shell script).
 */
async function prosodyWithPassword(subcommand, jid, password) {
  if (subcommand !== 'adduser' && subcommand !== 'passwd') {
    return { ok: false, stdout: '', stderr: 'invalid_subcommand' };
  }
  if (!/^[a-z0-9._-]{1,64}@[a-z0-9.-]+$/i.test(String(jid || ''))) {
    return { ok: false, stdout: '', stderr: 'invalid_jid' };
  }
  const script =
    'printf "%s\\n%s\\n" "$MU_PASS" "$MU_PASS" | ' +
    'prosodyctl --config "$MU_CFG" "$MU_SUB" "$MU_JID"';
  return dockerExec(['sh', '-c', script], {
    env: {
      MU_PASS: password,
      MU_JID: String(jid),
      MU_CFG: PROSODY_CONFIG,
      MU_SUB: subcommand,
    },
  });
}

async function prosodyctl(args) {
  return dockerExec(['prosodyctl', '--config', PROSODY_CONFIG, ...args]);
}

async function prosodyUserExists(username) {
  const user = assertSafeMeetUser(username);
  if (!user) return false;
  const candidates = [`${user}.dat`, `${encodeProsodyFilename(user)}.dat`];
  for (const name of candidates) {
    const filePath = `${prosodyAccountsDir()}/${name}`;
    const result = await dockerExec(['test', '-f', filePath]);
    if (result.ok) return true;
  }
  return false;
}

async function listProsodyUsers() {
  const dir = prosodyAccountsDir();
  const result = await dockerExec(['ls', '-1', dir]);
  if (!result.ok) {
    if (/No such file|cannot access/i.test(result.stderr + result.stdout)) {
      return [];
    }
    throw new Error(result.stderr || 'prosody_list_failed');
  }
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.dat'))
    .map((l) => decodeProsodyLocalpart(l.replace(/\.dat$/i, '')))
    .filter((u) => u && !PROSODY_SYSTEM_USERS.has(u));
}

async function prosodyAddUser(username, password) {
  const user = assertSafeMeetUser(username);
  if (!user) return { ok: false, error: 'invalid_meet_username' };
  if (PROSODY_SYSTEM_USERS.has(user)) {
    return { ok: false, error: 'reserved_meet_username' };
  }
  const jid = `${user}@${PROSODY_DOMAIN}`;
  if (await prosodyUserExists(user)) {
    return prosodySetPassword(user, password);
  }

  const result = await prosodyWithPassword('adduser', jid, password);
  if (result.ok || /OK: Created/i.test(result.stdout + result.stderr)) {
    return { ok: true };
  }

  const already =
    /already exists|account already|exists/i.test(result.stderr + result.stdout);
  if (already) return prosodySetPassword(user, password);

  const reg = await prosodyctl(['register', user, PROSODY_DOMAIN, password]);
  if (!reg.ok) {
    return {
      ok: false,
      error: (result.stderr || reg.stderr || 'prosody_add_failed').trim(),
    };
  }
  return { ok: true };
}

async function prosodySetPassword(username, password) {
  const user = assertSafeMeetUser(username);
  if (!user) return { ok: false, error: 'invalid_meet_username' };
  if (PROSODY_SYSTEM_USERS.has(user)) {
    return { ok: false, error: 'reserved_meet_username' };
  }
  const jid = `${user}@${PROSODY_DOMAIN}`;
  const result = await prosodyWithPassword('passwd', jid, password);
  if (result.ok || /password changed|OK/i.test(result.stdout + result.stderr)) {
    return { ok: true };
  }

  await prosodyctl(['deluser', jid]);
  const add = await prosodyWithPassword('adduser', jid, password);
  if (add.ok || /OK: Created/i.test(add.stdout + add.stderr)) {
    return { ok: true };
  }
  const reg = await prosodyctl(['register', user, PROSODY_DOMAIN, password]);
  if (!reg.ok) {
    return {
      ok: false,
      error: (result.stderr || add.stderr || reg.stderr || 'prosody_passwd_failed').trim(),
    };
  }
  return { ok: true };
}

async function unlinkProsodyAccountFiles(username) {
  const user = assertSafeMeetUser(username);
  if (!user) return;
  const stems = new Set([user, encodeProsodyFilename(user)]);
  // Also accept raw encoded form if UI still shows %2e
  const raw = String(username || '').trim().toLowerCase();
  if (raw) stems.add(raw.replace(/\.dat$/i, ''));
  for (const stem of stems) {
    if (!stem || stem.includes('/') || stem.includes('..')) continue;
    const acc = `${prosodyAccountsDir()}/${stem}.dat`;
    const role = `${prosodyAccountRolesDir()}/${stem}.dat`;
    await dockerExec(['rm', '-f', acc]);
    await dockerExec(['rm', '-f', role]);
  }
}

async function prosodyDeleteUser(username) {
  const user = assertSafeMeetUser(username);
  if (!user) return { ok: false, error: 'invalid_meet_username' };
  if (PROSODY_SYSTEM_USERS.has(user)) {
    return { ok: false, error: 'reserved_meet_username' };
  }
  const jid = `${user}@${PROSODY_DOMAIN}`;
  const result = await prosodyctl(['deluser', jid]);
  const msg = (result.stderr || result.stdout || '').trim();
  const gone = /does not exist|not found|no such/i.test(msg);
  if (result.ok || gone) {
    await unlinkProsodyAccountFiles(user);
    return { ok: true };
  }
  // Flat-file orphan (listed from disk but unknown to prosodyctl): remove files.
  const exists = await prosodyUserExists(user);
  if (!exists) {
    await unlinkProsodyAccountFiles(username);
    await unlinkProsodyAccountFiles(user);
    return { ok: true };
  }
  return { ok: false, error: msg || 'prosody_delete_failed' };
}


async function listOfficeUsers() {
  const { rows } = await pool.query(
    `SELECT id, email, "displayName", "createdAt"
     FROM "User"
     ORDER BY lower(email) ASC`
  );
  return rows;
}

async function findOfficeByEmail(email) {
  const { rows } = await pool.query(
    `SELECT id, email, "displayName", "createdAt" FROM "User" WHERE lower(email) = lower($1)`,
    [email]
  );
  return rows[0] || null;
}

async function createOfficeUser({ email, displayName, password }) {
  const existing = await findOfficeByEmail(email);
  if (existing) {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await pool.query(
      `UPDATE "User" SET "passwordHash" = $1, "displayName" = COALESCE(NULLIF($2, ''), "displayName") WHERE id = $3`,
      [passwordHash, displayName || '', existing.id]
    );
    return { ok: true, id: existing.id, updated: true };
  }
  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await pool.query(
    `INSERT INTO "User" (id, email, "passwordHash", "displayName", "createdAt")
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
    [id, email, passwordHash, displayName || localPart(email)]
  );
  return { ok: true, id, updated: false };
}

async function resetOfficePassword(email, password) {
  const user = await findOfficeByEmail(email);
  if (!user) return { ok: false, error: 'office_user_not_found' };
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await pool.query(`UPDATE "User" SET "passwordHash" = $1 WHERE id = $2`, [
    passwordHash,
    user.id,
  ]);
  return { ok: true, id: user.id };
}

async function deleteOfficeUser(email) {
  const user = await findOfficeByEmail(email);
  if (!user) return { ok: true, missing: true };
  try {
    await pool.query(`DELETE FROM "User" WHERE id = $1`, [user.id]);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err.code === '23503' ? 'user_has_meetings' : 'delete_failed',
    };
  }
}

function mergeUsers(officeRows, meetUsernames) {
  const meetSet = new Set(meetUsernames.map((u) => u.toLowerCase()));
  const usedMeet = new Set();
  const items = [];

  for (const row of officeRows) {
    const email = row.email;
    const meetUsername = localPart(email);
    const hasMeet = meetSet.has(meetUsername);
    if (hasMeet) usedMeet.add(meetUsername);
    items.push({
      id: row.id,
      email,
      displayName: row.displayName,
      meetUsername,
      createdAt: row.createdAt,
      hasOffice: true,
      hasMeet,
      sync: hasMeet ? 'both' : 'office',
    });
  }

  for (const username of meetUsernames) {
    if (usedMeet.has(username)) continue;
    items.push({
      id: `meet:${username}`,
      email: null,
      displayName: username,
      meetUsername: username,
      createdAt: null,
      hasOffice: false,
      hasMeet: true,
      sync: 'meet',
    });
  }

  items.sort((a, b) => {
    const ae = (a.email || a.meetUsername || '').toLowerCase();
    const be = (b.email || b.meetUsername || '').toLowerCase();
    return ae.localeCompare(be);
  });
  return items;
}

const router = express.Router();

router.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

router.post('/api/login', async (req, res) => {
  const rate = checkLoginRate(clientIp(req));
  if (!rate.ok) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return res.status(429).json({ error: 'too_many_attempts' });
  }
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'email_and_password_required' });
  }
  const admins = readAdmins();
  const admin = admins.find((a) => a.email?.toLowerCase() === email);
  if (!admin?.passwordHash) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const match = await bcrypt.compare(password, admin.passwordHash);
  if (!match) return res.status(401).json({ error: 'invalid_credentials' });
  req.session.authed = true;
  req.session.email = admin.email;
  req.session.displayName = admin.displayName || admin.email;
  return res.json({
    ok: true,
    user: { email: admin.email, displayName: admin.displayName },
  });
});

router.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/api/me', (req, res) => {
  if (!req.session?.authed) return res.status(401).json({ error: 'unauthorized' });
  res.json({
    user: {
      email: req.session.email,
      displayName: req.session.displayName,
    },
  });
});

router.get('/api/admins', requireAuth, (_req, res) => {
  const admins = readAdmins().map(({ email, displayName, createdAt }) => ({
    email,
    displayName,
    createdAt,
  }));
  res.json({ admins });
});

router.post('/api/admins', requireAuth, async (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  const displayName = String(req.body?.displayName || '').trim() || localPart(email);
  const password = String(req.body?.password || '');
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (password.length < 10) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  const admins = readAdmins();
  if (admins.some((a) => a.email?.toLowerCase() === email)) {
    return res.status(409).json({ error: 'admin_exists' });
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  admins.push({
    email,
    displayName,
    passwordHash,
    createdAt: new Date().toISOString(),
  });
  writeAdmins(admins);
  res.json({ ok: true, admin: { email, displayName } });
});

router.post('/api/admins/password', requireAuth, async (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || password.length < 10) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  const admins = readAdmins();
  const idx = admins.findIndex((a) => a.email?.toLowerCase() === email);
  if (idx < 0) return res.status(404).json({ error: 'not_found' });
  admins[idx].passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  writeAdmins(admins);
  res.json({ ok: true });
});

router.delete('/api/admins/:email', requireAuth, (req, res) => {
  const email = decodeURIComponent(req.params.email).trim().toLowerCase();
  const admins = readAdmins();
  if (admins.length <= 1) {
    return res.status(400).json({ error: 'cannot_remove_last_admin' });
  }
  const next = admins.filter((a) => a.email?.toLowerCase() !== email);
  if (next.length === admins.length) {
    return res.status(404).json({ error: 'not_found' });
  }
  writeAdmins(next);
  if (req.session.email?.toLowerCase() === email) {
    req.session = null;
  }
  res.json({ ok: true });
});

router.get('/api/users', requireAuth, async (_req, res) => {
  try {
    const [officeRows, meetUsers] = await Promise.all([
      listOfficeUsers(),
      listProsodyUsers(),
    ]);
    res.json({ items: mergeUsers(officeRows, meetUsers) });
  } catch (err) {
    console.error('[users-ui] list failed', err.message);
    res.status(500).json({ error: 'list_failed' });
  }
});

router.post('/api/users', requireAuth, async (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  const displayName = String(req.body?.displayName || '').trim();
  const meetUsername = assertSafeMeetUser(
    req.body?.meetUsername || localPart(email)
  );
  const password = String(req.body?.password || '');
  const alsoAdmin = Boolean(req.body?.alsoAdmin);

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (!meetUsername) {
    return res.status(400).json({ error: 'invalid_meet_username' });
  }
  if (PROSODY_SYSTEM_USERS.has(meetUsername)) {
    return res.status(400).json({ error: 'reserved_meet_username' });
  }
  if (password.length < 10) {
    return res.status(400).json({ error: 'password_too_short' });
  }

  try {
    const [office, meet] = await Promise.all([
      createOfficeUser({
        email,
        displayName: displayName || localPart(email),
        password,
      }),
      prosodyAddUser(meetUsername, password),
    ]);
    if (!meet.ok) {
      return res.status(500).json({
        error: 'meet_create_failed',
        office: office.ok,
      });
    }

    if (alsoAdmin) {
      const admins = readAdmins();
      if (!admins.some((a) => a.email?.toLowerCase() === email)) {
        admins.push({
          email,
          displayName: displayName || localPart(email),
          passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
          createdAt: new Date().toISOString(),
        });
        writeAdmins(admins);
      }
    }

    res.json({
      ok: true,
      email,
      meetUsername,
      officeUpdated: office.updated,
      alsoAdmin,
    });
  } catch (err) {
    console.error('[users-ui] create failed', err.message);
    res.status(500).json({ error: 'create_failed' });
  }
});

router.post('/api/users/password', requireAuth, async (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  const rawMeet =
    req.body?.meetUsername || (email ? localPart(email) : '');
  const meetUsername = rawMeet ? assertSafeMeetUser(rawMeet) : null;
  if (rawMeet && !meetUsername) {
    return res.status(400).json({ error: 'invalid_meet_username' });
  }
  const password = String(req.body?.password || '');
  if (password.length < 10) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  if (!email && !meetUsername) {
    return res.status(400).json({ error: 'email_or_meet_required' });
  }

  const results = { office: null, meet: null };
  try {
    const tasks = [];
    if (email) {
      tasks.push(
        resetOfficePassword(email, password).then((r) => {
          results.office = r;
        })
      );
    }
    if (meetUsername) {
      tasks.push(
        prosodyAddUser(meetUsername, password).then((r) => {
          results.meet = r;
        })
      );
    }
    await Promise.all(tasks);
    if (
      (results.office && !results.office.ok && results.office.error !== 'office_user_not_found') ||
      (results.meet && !results.meet.ok)
    ) {
      return res.status(500).json({ error: 'reset_partial', results });
    }
    res.json({ ok: true, results });
  } catch (err) {
    console.error('[users-ui] reset failed', err.message);
    res.status(500).json({ error: 'reset_failed' });
  }
});

router.post('/api/users/delete', requireAuth, async (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  const rawMeet =
    req.body?.meetUsername || (email ? localPart(email) : '');
  const meetUsername = rawMeet ? assertSafeMeetUser(rawMeet) : null;
  if (rawMeet && !meetUsername) {
    return res.status(400).json({ error: 'invalid_meet_username' });
  }

  if (!email && !meetUsername) {
    return res.status(400).json({ error: 'email_or_meet_required' });
  }

  const results = { office: null, meet: null };
  try {
    if (email) results.office = await deleteOfficeUser(email);
    if (meetUsername) results.meet = await prosodyDeleteUser(meetUsername);

    if (results.office && !results.office.ok) {
      return res.status(409).json({ error: results.office.error, results });
    }
    if (results.meet && !results.meet.ok) {
      return res.status(500).json({
        error: 'meet_delete_failed',
        detail: results.meet.error || null,
        results,
      });
    }
    res.json({ ok: true, results });
  } catch (err) {
    console.error('[users-ui] delete failed', err.message);
    res.status(500).json({ error: 'delete_failed' });
  }
});

router.get('/assets/logo-dark.png', (_req, res) => {
  if (fs.existsSync(LOGO_DARK)) return res.sendFile(LOGO_DARK);
  const local = path.join(__dirname, 'public', 'assets', 'logo-dark.png');
  if (fs.existsSync(local)) return res.sendFile(local);
  res.status(404).end();
});

router.get('/assets/logo-white.png', (_req, res) => {
  if (fs.existsSync(LOGO_WHITE)) return res.sendFile(LOGO_WHITE);
  const local = path.join(__dirname, 'public', 'assets', 'logo-white.png');
  if (fs.existsSync(local)) return res.sendFile(local);
  res.status(404).end();
});

router.get('/assets/favicon.png', (_req, res) => {
  if (fs.existsSync(FAVICON_FILE)) return res.sendFile(FAVICON_FILE);
  if (fs.existsSync(LOGO_DARK)) return res.sendFile(LOGO_DARK);
  res.status(404).end();
});

router.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));

router.get(['/', '/login', '/admins'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(BASE || '/', router);
if (BASE) {
  app.get('/', (_req, res) => res.redirect(BASE + '/'));
}

await ensureBootstrapAdmin();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mindful Users listening on :${PORT} base=${BASE || '/'}`);
});
