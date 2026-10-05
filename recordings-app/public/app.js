const BASE = '/recordings';

function $(sel, el = document) {
  return el.querySelector(sel);
}

function formatBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function applyTheme(mode) {
  const next = mode || localStorage.getItem('mr-theme') || 'auto';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('mr-theme', next);
  syncLogos();
  return next;
}

function isDarkTheme() {
  const theme = document.documentElement.dataset.theme || 'auto';
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function logoSrc() {
  return `${BASE}/assets/${isDarkTheme() ? 'logo-white' : 'logo-dark'}.png?v=4`;
}

function syncLogos(root = document) {
  root.querySelectorAll('img.js-brand-logo').forEach((img) => {
    img.src = logoSrc();
  });
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const cur = document.documentElement.dataset.theme || 'auto';
  const i = order.indexOf(cur);
  return applyTheme(order[(i + 1) % order.length]);
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.error || res.statusText);
    e.status = res.status;
    throw e;
  }
  if (res.status === 204) return null;
  return res.json();
}

function themeLabel() {
  const t = document.documentElement.dataset.theme || 'auto';
  return t === 'auto' ? 'Theme: Auto' : t === 'light' ? 'Theme: Light' : 'Theme: Dark';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatExpiry(iso) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso || '';
  }
}

function absoluteShareUrl(tokenOrPath) {
  if (tokenOrPath.startsWith('http')) return tokenOrPath;
  const path = tokenOrPath.startsWith('/') ? tokenOrPath : `${BASE}/s/${tokenOrPath}`;
  return `${location.origin}${path}`;
}

function parseShareToken() {
  const pathMatch = location.pathname.match(/\/s\/([^/]+)\/?$/);
  if (pathMatch) return decodeURIComponent(pathMatch[1]);
  const hash = location.hash || '';
  if (hash.startsWith('#/s/')) return decodeURIComponent(hash.slice('#/s/'.length).split(/[?#]/)[0]);
  if (hash.startsWith('#/share/')) return decodeURIComponent(hash.slice('#/share/'.length).split(/[?#]/)[0]);
  return null;
}

function renderLogin(root, { error } = {}) {
  root.innerHTML = `
    <div class="login-page">
      <form class="login-card" id="login-form">
        <div class="logo-wrap">
          <img class="js-brand-logo brand-logo" src="${logoSrc()}" alt="Mindful Design" />
          <h1>Mindful Recordings</h1>
          <p>Sign in to browse and play meeting recordings.</p>
        </div>
        ${error ? `<div class="error">${error}</div>` : ''}
        <div class="field">
          <label for="username">Username</label>
          <input id="username" name="username" autocomplete="username" value="admin" required />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
        </div>
        <button class="btn btn-primary" style="width:100%;margin-top:8px" type="submit">Sign in</button>
      </form>
    </div>
  `;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username: $('#username').value.trim(),
          password: $('#password').value,
        }),
      });
      location.hash = '#/';
      await route();
    } catch {
      renderLogin(root, { error: 'Incorrect username or password.' });
    }
  });
}

function shell(content, { title, publicMode } = {}) {
  return `
    <div class="shell ${publicMode ? 'shell-public' : ''}">
      <header class="topbar">
        <div class="brand">
          <img class="js-brand-logo brand-logo" src="${logoSrc()}" alt="Mindful Design" />
          <div class="brand-text">
            <h1 class="brand-title">${title || 'Mindful Recordings'}</h1>
          </div>
        </div>
        <div class="top-actions">
          <button type="button" class="icon-btn" id="theme-btn" title="Toggle theme">${themeLabel()}</button>
          ${publicMode ? '' : '<button type="button" class="btn btn-ghost" id="logout-btn">Log out</button>'}
        </div>
      </header>
      ${content}
    </div>
  `;
}

function bindChrome(root, { publicMode } = {}) {
  $('#theme-btn', root)?.addEventListener('click', () => {
    cycleTheme();
    $('#theme-btn', root).textContent = themeLabel();
    syncLogos(root);
  });
  if (!publicMode) {
    $('#logout-btn', root)?.addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' });
      location.hash = '#/login';
      await route();
    });
  }
}

async function renderLibrary(root) {
  const data = await api('/api/recordings');
  const items = data.items || [];
  root.innerHTML = shell(`
    <div class="toolbar">
      <div class="search">
        <input type="search" id="q" placeholder="Search by room or date…" autocomplete="off" />
      </div>
      <div class="meta-count" id="count">${items.length} recording${items.length === 1 ? '' : 's'}</div>
    </div>
    <div class="grid" id="grid"></div>
    <div class="empty hidden" id="empty">No recordings match your search.</div>
  `);
  bindChrome(root);

  const grid = $('#grid', root);
  const empty = $('#empty', root);
  const count = $('#count', root);

  function paint(list) {
    grid.innerHTML = '';
    if (!list.length) {
      empty.classList.remove('hidden');
      empty.textContent = items.length
        ? 'No recordings match your search.'
        : 'No recordings yet. Start one from Mindful Meet.';
      count.textContent = '0 recordings';
      return;
    }
    empty.classList.add('hidden');
    count.textContent = `${list.length} recording${list.length === 1 ? '' : 's'}`;
    for (const item of list) {
      const el = document.createElement('article');
      el.className = 'card';
      el.innerHTML = `
        <span class="badge">Video</span>
        <h2>${escapeHtml(item.title)}</h2>
        <div class="sub">${escapeHtml(item.roomTitle)} · ${formatBytes(item.size)}</div>
      `;
      el.addEventListener('click', () => {
        location.hash = `#/watch/${encodeURIComponent(item.id)}`;
      });
      grid.appendChild(el);
    }
  }

  paint(items);
  $('#q', root).addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) return paint(items);
    paint(
      items.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.roomTitle.toLowerCase().includes(q) ||
          (i.room || '').toLowerCase().includes(q) ||
          (i.downloadName || '').toLowerCase().includes(q)
      )
    );
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

async function refreshShareList(panel, recordingId) {
  const listEl = $('#share-list', panel);
  const emptyEl = $('#share-list-empty', panel);
  if (!listEl) return;
  try {
    const data = await api(`/api/shares?recordingId=${encodeURIComponent(recordingId)}`);
    const items = data.items || [];
    listEl.innerHTML = '';
    if (!items.length) {
      emptyEl?.classList.remove('hidden');
      return;
    }
    emptyEl?.classList.add('hidden');
    for (const share of items) {
      const row = document.createElement('div');
      row.className = 'share-row';
      const fullUrl = absoluteShareUrl(share.url || share.token);
      row.innerHTML = `
        <div class="share-row-meta">
          <code class="share-url">${escapeHtml(fullUrl)}</code>
          <div class="sub">Expires ${escapeHtml(formatExpiry(share.expiresAt))}${
            share.allowDownload ? ' · download on' : ''
          }</div>
        </div>
        <div class="share-row-actions">
          <button type="button" class="btn" data-copy>Copy</button>
          <button type="button" class="btn btn-danger" data-revoke>Revoke</button>
        </div>
      `;
      $('[data-copy]', row).addEventListener('click', async () => {
        const ok = await copyText(fullUrl);
        const btn = $('[data-copy]', row);
        btn.textContent = ok ? 'Copied' : 'Failed';
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 1500);
      });
      $('[data-revoke]', row).addEventListener('click', async () => {
        if (!confirm('Revoke this share link? Anyone with the link will lose access.')) return;
        await api(`/api/shares/${encodeURIComponent(share.token)}`, { method: 'DELETE' });
        await refreshShareList(panel, recordingId);
      });
      listEl.appendChild(row);
    }
  } catch (e) {
    listEl.innerHTML = `<div class="error">Could not load shares: ${escapeHtml(e.message)}</div>`;
  }
}

function openSharePanel(root, item) {
  let panel = $('#share-panel', root);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'share-panel';
    panel.className = 'share-panel';
    const actions = $('.player-actions', root);
    (actions?.parentElement || $('.player-meta', root) || root).appendChild(panel);
  }
  panel.innerHTML = `
    <div class="share-panel-head">
      <h2>Share with customer</h2>
      <p class="sub">Creates a private link to this recording only. No gallery access.</p>
    </div>
    <div class="share-form">
      <div class="field">
        <label for="share-expiry">Link expires in</label>
        <select id="share-expiry">
          <option value="7">7 days</option>
          <option value="30" selected>30 days</option>
          <option value="90">90 days</option>
        </select>
      </div>
      <label class="check-row">
        <input type="checkbox" id="share-download" />
        <span>Allow download</span>
      </label>
      <button type="button" class="btn btn-primary" id="share-create">Create &amp; copy link</button>
    </div>
    <div class="share-status" id="share-status" hidden></div>
    <h3 class="share-list-title">Active links</h3>
    <div class="share-list-empty sub" id="share-list-empty">No active share links.</div>
    <div class="share-list" id="share-list"></div>
  `;

  $('#share-create', panel).addEventListener('click', async () => {
    const status = $('#share-status', panel);
    const btn = $('#share-create', panel);
    btn.disabled = true;
    status.hidden = false;
    status.className = 'share-status';
    status.textContent = 'Creating…';
    try {
      const expiresInDays = Number($('#share-expiry', panel).value || 30);
      const allowDownload = $('#share-download', panel).checked;
      const created = await api('/api/shares', {
        method: 'POST',
        body: JSON.stringify({ id: item.id, expiresInDays, allowDownload }),
      });
      const fullUrl = absoluteShareUrl(created.url || created.token);
      const ok = await copyText(fullUrl);
      status.className = 'share-status ok';
      status.textContent = ok
        ? 'Link created and copied to clipboard.'
        : `Link created: ${fullUrl}`;
      await refreshShareList(panel, item.id);
    } catch (e) {
      status.className = 'share-status error';
      status.textContent = e.message || 'Could not create share.';
    } finally {
      btn.disabled = false;
    }
  });

  refreshShareList(panel, item.id);
}

async function renderPlayer(root, id) {
  const data = await api('/api/recordings');
  const item = (data.items || []).find((i) => i.id === id);
  if (!item) {
    root.innerHTML = shell(`<div class="empty">Recording not found.</div>`);
    bindChrome(root);
    return;
  }
  root.innerHTML = shell(
    `
    <div class="player-actions" style="margin-bottom:14px">
      <button type="button" class="btn" id="back-btn">← Library</button>
    </div>
    <div class="player-wrap">
      <video controls playsinline preload="metadata" src="${item.streamUrl}"></video>
      <div class="player-meta">
        <h1>${escapeHtml(item.title)}</h1>
        <div class="sub">${escapeHtml(item.roomTitle)} · ${formatBytes(item.size)}</div>
        <div class="player-actions">
          <a class="btn" href="${item.downloadUrl}" download>Download</a>
          <button type="button" class="btn" id="share-btn">Share</button>
        </div>
      </div>
    </div>
  `,
    { title: 'Mindful Recordings' }
  );
  bindChrome(root);
  $('#back-btn', root).addEventListener('click', () => {
    location.hash = '#/';
  });
  $('#share-btn', root).addEventListener('click', () => {
    openSharePanel(root, item);
    $('#share-panel', root)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

async function renderPublicShare(root, token) {
  applyTheme();
  try {
    const data = await api(`/api/share/${encodeURIComponent(token)}`);
    root.innerHTML = shell(
      `
      <div class="player-wrap public-player">
        <video controls playsinline preload="metadata" src="${escapeHtml(data.streamUrl)}"></video>
        <div class="player-meta">
          <h1>${escapeHtml(data.title)}</h1>
          <div class="sub">${escapeHtml(data.roomTitle)} · ${formatBytes(data.size)}</div>
          <div class="sub">Link expires ${escapeHtml(formatExpiry(data.expiresAt))}</div>
          <div class="player-actions">
            ${
              data.allowDownload && data.downloadUrl
                ? `<a class="btn" href="${escapeHtml(data.downloadUrl)}" download>Download</a>`
                : ''
            }
          </div>
        </div>
      </div>
    `,
      { title: 'Mindful Recordings', publicMode: true }
    );
    bindChrome(root, { publicMode: true });
  } catch (e) {
    root.innerHTML = shell(
      `
      <div class="empty public-expired">
        <h2>Link unavailable</h2>
        <p>This share link has expired, been revoked, or is not valid.</p>
      </div>
    `,
      { title: 'Mindful Recordings', publicMode: true }
    );
    bindChrome(root, { publicMode: true });
  }
}

async function route() {
  applyTheme();
  const root = $('#app');
  const shareToken = parseShareToken();
  if (shareToken) {
    await renderPublicShare(root, shareToken);
    return;
  }

  const hash = location.hash || '#/';

  try {
    if (hash.startsWith('#/login')) {
      renderLogin(root);
      return;
    }
    await api('/api/me');
    if (hash.startsWith('#/watch/')) {
      const id = decodeURIComponent(hash.slice('#/watch/'.length));
      await renderPlayer(root, id);
      return;
    }
    await renderLibrary(root);
  } catch (e) {
    if (e.status === 401) {
      renderLogin(root);
      return;
    }
    root.innerHTML = `<div class="login-page"><div class="login-card"><h1>Something went wrong</h1><p>${escapeHtml(
      e.message
    )}</p></div></div>`;
  }
}

window.addEventListener('hashchange', route);
applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((document.documentElement.dataset.theme || 'auto') === 'auto') syncLogos();
});
route();
