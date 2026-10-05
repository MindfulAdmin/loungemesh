const BASE = '/users';

function $(sel, el = document) {
  return el.querySelector(sel);
}

function applyTheme(mode) {
  const next = mode || localStorage.getItem('mu-theme') || 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('mu-theme', next);
  syncLogos();
  return next;
}

function isDarkTheme() {
  const theme = document.documentElement.dataset.theme || 'light';
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function logoSrc() {
  return `${BASE}/assets/${isDarkTheme() ? 'logo-white' : 'logo-dark'}.png?v=1`;
}

function syncLogos(root = document) {
  root.querySelectorAll('img.js-brand-logo').forEach((img) => {
    img.src = logoSrc();
  });
}

function cycleTheme() {
  const order = ['light', 'dark', 'auto'];
  const cur = document.documentElement.dataset.theme || 'light';
  const i = order.indexOf(cur);
  return applyTheme(order[(i + 1) % order.length]);
}

function themeLabel() {
  const t = document.documentElement.dataset.theme || 'light';
  return t === 'auto' ? 'Theme: Auto' : t === 'light' ? 'Theme: Light' : 'Theme: Dark';
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
    e.payload = err;
    throw e;
  }
  if (res.status === 204) return null;
  return res.json();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generatePassword(len = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function setBusy(btn, busy, labelBusy) {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = labelBusy || 'Working…';
  } else {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
    btn.textContent = btn.dataset.label || btn.textContent;
  }
}

function localPart(email) {
  const s = String(email || '');
  const i = s.indexOf('@');
  return i > 0 ? s.slice(0, i) : s;
}

function syncBadge(sync) {
  if (sync === 'both') return '<span class="badge badge-both">Office + Meet</span>';
  if (sync === 'office') return '<span class="badge badge-office">Office only</span>';
  return '<span class="badge badge-meet">Meet only</span>';
}

function closeModal() {
  $('#modal-root')?.remove();
}

function openModal(html) {
  closeModal();
  const wrap = document.createElement('div');
  wrap.id = 'modal-root';
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) closeModal();
  });
  document.body.appendChild(wrap);
  return wrap;
}

function renderLogin(root, { error } = {}) {
  root.innerHTML = `
    <div class="login-page">
      <form class="login-card" id="login-form">
        <div class="logo-wrap">
          <img class="js-brand-logo brand-logo" src="${logoSrc()}" alt="Mindful Design" />
          <h1>Mindful Users</h1>
          <p>Manage Office and Meet accounts.</p>
        </div>
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
        <div class="field">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="username" required />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
        </div>
        <button class="btn btn-primary" style="width:100%;margin-top:8px" type="submit" id="login-submit">Sign in</button>
      </form>
    </div>
  `;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-submit');
    setBusy(btn, true, 'Signing in…');
    try {
      await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          email: $('#email').value.trim(),
          password: $('#password').value,
        }),
      });
      location.hash = '#/';
      await route();
    } catch {
      renderLogin(root, { error: 'Incorrect email or password.' });
    }
  });
}

function shell(content, { title, tab } = {}) {
  return `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <img class="js-brand-logo brand-logo" src="${logoSrc()}" alt="Mindful Design" />
          <div class="brand-text">
            <h1 class="brand-title">${title || 'Mindful Users'}</h1>
          </div>
        </div>
        <div class="top-actions">
          <button type="button" class="icon-btn" id="theme-btn" title="Toggle theme">${themeLabel()}</button>
          <button type="button" class="btn btn-ghost" id="logout-btn">Log out</button>
        </div>
      </header>
      <nav class="tabs" aria-label="Sections">
        <button type="button" class="tab ${tab === 'users' ? 'is-active' : ''}" data-tab="users">Users</button>
        <button type="button" class="tab ${tab === 'admins' ? 'is-active' : ''}" data-tab="admins">Admins</button>
      </nav>
      ${content}
    </div>
  `;
}

function bindChrome(root) {
  $('#theme-btn', root)?.addEventListener('click', () => {
    cycleTheme();
    $('#theme-btn', root).textContent = themeLabel();
    syncLogos(root);
  });
  $('#logout-btn', root)?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.hash = '#/login';
    await route();
  });
  root.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      location.hash = btn.dataset.tab === 'admins' ? '#/admins' : '#/';
    });
  });
}

function showCreateUserModal(onDone) {
  const wrap = openModal(`
    <h2>Add user</h2>
    <p class="hint">Creates matching Office and Meet accounts with the same password.</p>
    <div id="form-error" class="error hidden"></div>
    <form id="create-form">
      <div class="field">
        <label for="c-email">Email</label>
        <input id="c-email" type="email" required autocomplete="off" />
      </div>
      <div class="field">
        <label for="c-name">Display name</label>
        <input id="c-name" type="text" autocomplete="off" />
      </div>
      <div class="field">
        <label for="c-meet">Meet username</label>
        <input id="c-meet" type="text" autocomplete="off" />
      </div>
      <div class="field">
        <label for="c-pass">Password</label>
        <div class="gen-row">
          <input id="c-pass" type="password" minlength="10" required autocomplete="new-password" />
          <button type="button" class="btn" id="c-gen">Generate</button>
        </div>
      </div>
      <label class="check-row">
        <input type="checkbox" id="c-admin" />
        <span>Also make Users admin</span>
      </label>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="c-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="c-submit">Create</button>
      </div>
    </form>
  `);

  const email = $('#c-email', wrap);
  const meet = $('#c-meet', wrap);
  const name = $('#c-name', wrap);
  email.addEventListener('input', () => {
    if (!meet.dataset.touched) meet.value = localPart(email.value.trim().toLowerCase());
    if (!name.dataset.touched) {
      const lp = localPart(email.value.trim());
      name.value = lp ? lp.charAt(0).toUpperCase() + lp.slice(1) : '';
    }
  });
  meet.addEventListener('input', () => {
    meet.dataset.touched = '1';
  });
  name.addEventListener('input', () => {
    name.dataset.touched = '1';
  });
  $('#c-gen', wrap).addEventListener('click', () => {
    const el = $('#c-pass', wrap);
    el.type = 'text';
    el.value = generatePassword();
    setTimeout(() => { el.type = 'password'; }, 5000);
  });
  $('#c-cancel', wrap).addEventListener('click', closeModal);
  $('#create-form', wrap).addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#form-error', wrap);
    const btn = $('#c-submit', wrap);
    errEl.classList.add('hidden');
    setBusy(btn, true, 'Creating…');
    $('#c-cancel', wrap).disabled = true;
    try {
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          email: email.value.trim(),
          displayName: name.value.trim(),
          meetUsername: meet.value.trim(),
          password: $('#c-pass', wrap).value,
          alsoAdmin: $('#c-admin', wrap).checked,
        }),
      });
      closeModal();
      onDone?.();
    } catch (err) {
      const msg =
        err.message === 'meet_create_failed'
          ? 'Office saved, but Meet host failed. Use Reset password to retry Meet.'
          : err.message || 'Create failed';
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
      setBusy(btn, false);
      $('#c-cancel', wrap).disabled = false;
    }
  });
}

function showResetModal(user, onDone) {
  const label = user.email || user.meetUsername;
  const wrap = openModal(`
    <h2>Reset password</h2>
    <p class="hint">Sets the same password on Office and Meet for <strong>${escapeHtml(label)}</strong>.</p>
    <div id="form-error" class="error hidden"></div>
    <form id="reset-form">
      <div class="field">
        <label for="r-pass">New password</label>
        <div class="gen-row">
          <input id="r-pass" type="password" minlength="10" required autocomplete="new-password" />
          <button type="button" class="btn" id="r-gen">Generate</button>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="r-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="r-submit">Save password</button>
      </div>
    </form>
  `);
  $('#r-gen', wrap).addEventListener('click', () => {
    const el = $('#r-pass', wrap);
    el.type = 'text';
    el.value = generatePassword();
    setTimeout(() => { el.type = 'password'; }, 5000);
  });
  $('#r-cancel', wrap).addEventListener('click', closeModal);
  $('#reset-form', wrap).addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#form-error', wrap);
    const btn = $('#r-submit', wrap);
    errEl.classList.add('hidden');
    setBusy(btn, true, 'Saving…');
    $('#r-cancel', wrap).disabled = true;
    try {
      await api('/api/users/password', {
        method: 'POST',
        body: JSON.stringify({
          email: user.email || '',
          meetUsername: user.meetUsername || '',
          password: $('#r-pass', wrap).value,
        }),
      });
      closeModal();
      onDone?.();
    } catch (err) {
      errEl.textContent = err.message || 'Reset failed';
      errEl.classList.remove('hidden');
      setBusy(btn, false);
      $('#r-cancel', wrap).disabled = false;
    }
  });
}

async function renderUsers(root) {
  root.innerHTML = shell(
    `<div class="empty" id="loading">Loading users…</div>`,
    { title: 'Mindful Users', tab: 'users' }
  );
  bindChrome(root);

  const data = await api('/api/users');
  let items = data.items || [];

  root.innerHTML = shell(
    `
    <div class="toolbar">
      <div class="search">
        <input type="search" id="q" placeholder="Search by email or Meet username…" autocomplete="off" />
      </div>
      <button type="button" class="btn btn-primary" id="add-user">Add user</button>
      <div class="meta-count" id="count">${items.length} user${items.length === 1 ? '' : 's'}</div>
    </div>
    <div class="user-list" id="list"></div>
    <div class="empty hidden" id="empty">No users yet.</div>
  `,
    { title: 'Mindful Users', tab: 'users' }
  );
  bindChrome(root);

  const list = $('#list', root);
  const empty = $('#empty', root);
  const count = $('#count', root);

  function paint(filtered) {
    list.innerHTML = '';
    if (!filtered.length) {
      empty.classList.remove('hidden');
      empty.textContent = items.length ? 'No users match your search.' : 'No users yet. Add one to get started.';
      count.textContent = '0 users';
      return;
    }
    empty.classList.add('hidden');
    count.textContent = `${filtered.length} user${filtered.length === 1 ? '' : 's'}`;
    for (const u of filtered) {
      const row = document.createElement('article');
      row.className = 'user-row';
      const title = u.displayName || u.email || u.meetUsername;
      const subParts = [];
      if (u.email) subParts.push(u.email);
      if (u.meetUsername) subParts.push(`Meet: ${u.meetUsername}`);
      row.innerHTML = `
        <div class="user-main">
          <h2>${escapeHtml(title)}</h2>
          <div class="sub">${escapeHtml(subParts.join(' · '))}</div>
        </div>
        <div class="user-badges">${syncBadge(u.sync)}</div>
        <div class="user-actions">
          <button type="button" class="btn js-reset">Reset password</button>
          <button type="button" class="btn btn-danger js-delete">Delete</button>
        </div>
      `;
      $('.js-reset', row).addEventListener('click', () => {
        showResetModal(u, () => renderUsers(root));
      });
      $('.js-delete', row).addEventListener('click', async () => {
        const label = u.email || u.meetUsername;
        if (!window.confirm(`Delete ${label} from Office and Meet? This cannot be undone.`)) return;
        const btn = $('.js-delete', row);
        setBusy(btn, true, 'Deleting…');
        try {
          await api('/api/users/delete', {
            method: 'POST',
            body: JSON.stringify({
              email: u.email || '',
              meetUsername: u.meetUsername || '',
            }),
          });
          await renderUsers(root);
        } catch (err) {
          setBusy(btn, false);
          alert(err.message === 'user_has_meetings'
            ? 'Cannot delete: this Office user still hosts meetings.'
            : err.message || 'Delete failed');
        }
      });
      list.appendChild(row);
    }
  }

  paint(items);
  $('#q', root).addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    paint(
      items.filter((u) => {
        const hay = `${u.email || ''} ${u.displayName || ''} ${u.meetUsername || ''}`.toLowerCase();
        return hay.includes(q);
      })
    );
  });
  $('#add-user', root).addEventListener('click', () => {
    showCreateUserModal(() => renderUsers(root));
  });
}

function showAddAdminModal(onDone) {
  const wrap = openModal(`
    <h2>Add admin</h2>
    <p class="hint">Admins can sign in to this Users panel only.</p>
    <div id="form-error" class="error hidden"></div>
    <form id="admin-form">
      <div class="field">
        <label for="a-email">Email</label>
        <input id="a-email" type="email" required />
      </div>
      <div class="field">
        <label for="a-name">Display name</label>
        <input id="a-name" type="text" />
      </div>
      <div class="field">
        <label for="a-pass">Password</label>
        <div class="gen-row">
          <input id="a-pass" type="password" minlength="10" required autocomplete="new-password" />
          <button type="button" class="btn" id="a-gen">Generate</button>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="a-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="a-submit">Add admin</button>
      </div>
    </form>
  `);
  $('#a-gen', wrap).addEventListener('click', () => {
    const el = $('#a-pass', wrap);
    el.type = 'text';
    el.value = generatePassword();
    setTimeout(() => { el.type = 'password'; }, 5000);
  });
  $('#a-cancel', wrap).addEventListener('click', closeModal);
  $('#admin-form', wrap).addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#form-error', wrap);
    const btn = $('#a-submit', wrap);
    errEl.classList.add('hidden');
    setBusy(btn, true, 'Adding…');
    $('#a-cancel', wrap).disabled = true;
    try {
      await api('/api/admins', {
        method: 'POST',
        body: JSON.stringify({
          email: $('#a-email', wrap).value.trim(),
          displayName: $('#a-name', wrap).value.trim(),
          password: $('#a-pass', wrap).value,
        }),
      });
      closeModal();
      onDone?.();
    } catch (err) {
      errEl.textContent = err.message || 'Failed';
      errEl.classList.remove('hidden');
      setBusy(btn, false);
      $('#a-cancel', wrap).disabled = false;
    }
  });
}

function showAdminPasswordModal(admin, onDone) {
  const wrap = openModal(`
    <h2>Reset admin password</h2>
    <p class="hint">${escapeHtml(admin.email)}</p>
    <div id="form-error" class="error hidden"></div>
    <form id="ap-form">
      <div class="field">
        <label for="ap-pass">New password</label>
        <div class="gen-row">
          <input id="ap-pass" type="password" minlength="10" required autocomplete="new-password" />
          <button type="button" class="btn" id="ap-gen">Generate</button>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="ap-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="ap-submit">Save</button>
      </div>
    </form>
  `);
  $('#ap-gen', wrap).addEventListener('click', () => {
    const el = $('#ap-pass', wrap);
    el.type = 'text';
    el.value = generatePassword();
    setTimeout(() => { el.type = 'password'; }, 5000);
  });
  $('#ap-cancel', wrap).addEventListener('click', closeModal);
  $('#ap-form', wrap).addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#form-error', wrap);
    const btn = $('#ap-submit', wrap);
    setBusy(btn, true, 'Saving…');
    $('#ap-cancel', wrap).disabled = true;
    try {
      await api('/api/admins/password', {
        method: 'POST',
        body: JSON.stringify({
          email: admin.email,
          password: $('#ap-pass', wrap).value,
        }),
      });
      closeModal();
      onDone?.();
    } catch (err) {
      errEl.textContent = err.message || 'Failed';
      errEl.classList.remove('hidden');
      setBusy(btn, false);
      $('#ap-cancel', wrap).disabled = false;
    }
  });
}

async function renderAdmins(root) {
  const data = await api('/api/admins');
  const me = await api('/api/me');
  const admins = data.admins || [];

  root.innerHTML = shell(
    `
    <div class="toolbar">
      <div class="meta-count">${admins.length} admin${admins.length === 1 ? '' : 's'}</div>
      <button type="button" class="btn btn-primary" id="add-admin">Add admin</button>
    </div>
    <div class="user-list" id="list"></div>
  `,
    { title: 'Mindful Users', tab: 'admins' }
  );
  bindChrome(root);

  const list = $('#list', root);
  for (const a of admins) {
    const row = document.createElement('article');
    row.className = 'user-row';
    row.innerHTML = `
      <div class="user-main">
        <h2>${escapeHtml(a.displayName || a.email)}</h2>
        <div class="sub">${escapeHtml(a.email)}</div>
      </div>
      <div class="user-actions">
        <button type="button" class="btn js-reset">Reset password</button>
        <button type="button" class="btn btn-danger js-delete" ${admins.length <= 1 ? 'disabled' : ''}>Remove</button>
      </div>
    `;
    $('.js-reset', row).addEventListener('click', () => {
      showAdminPasswordModal(a, () => renderAdmins(root));
    });
    $('.js-delete', row).addEventListener('click', async () => {
      if (admins.length <= 1) return;
      if (!window.confirm(`Remove admin ${a.email}?`)) return;
      try {
        await api(`/api/admins/${encodeURIComponent(a.email)}`, { method: 'DELETE' });
        if (me.user?.email?.toLowerCase() === a.email.toLowerCase()) {
          location.hash = '#/login';
          await route();
          return;
        }
        await renderAdmins(root);
      } catch (err) {
        alert(err.message || 'Remove failed');
      }
    });
    list.appendChild(row);
  }

  $('#add-admin', root).addEventListener('click', () => {
    showAddAdminModal(() => renderAdmins(root));
  });
}

async function route() {
  const root = $('#app');
  applyTheme();
  const hash = location.hash || '#/';

  if (hash.startsWith('#/login')) {
    renderLogin(root);
    return;
  }

  try {
    await api('/api/me');
  } catch {
    location.hash = '#/login';
    renderLogin(root);
    return;
  }

  if (hash.startsWith('#/admins')) {
    await renderAdmins(root);
  } else {
    await renderUsers(root);
  }
}

window.addEventListener('hashchange', () => {
  route().catch(console.error);
});
window
  .matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', () => {
    if (document.documentElement.dataset.theme === 'auto') syncLogos();
  });

route().catch(console.error);
