// /js/nav-auth.js
// Locks/unlocks gated nav links, converts data-href→href after login,
// renders avatar menu with logout, and gates admin-only links.

import { auth, db } from '/js/auth.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// Support BOTH styles: [data-gated] (Option A) and .link--gated (legacy)
const GATED_SEL = '[data-gated], .link--gated';

/* ---------- Styles (once) ---------- */
(function ensureStyles() {
  if (document.getElementById('pw-auth-styles')) return;
  const css = `
    .auth { display:flex; align-items:center; gap:10px; }
    .auth .auth-cta .btn { margin-left: 6px; }
    .auth-menu { position: relative; }
    .auth-menu .avatar-btn { border:0; background:transparent; padding:0; cursor:pointer; }
    .auth-menu .avatar-circle {
      width: 32px; height: 32px; border-radius: 9999px;
      display:inline-flex; align-items:center; justify-content:center;
      background:#111; color:#fff; font-weight:600; font-size:14px;
      box-shadow: 0 1px 2px rgba(0,0,0,.06);
      user-select: none;
    }
    .auth-menu .menu {
      position: absolute; right: 0; top: calc(100% + 8px);
      background: #fff; border: 1px solid var(--border);
      border-radius: 10px; min-width: 200px; padding: 8px;
      box-shadow: 0 12px 30px rgba(0,0,0,.08); z-index: 50;
    }
    .auth-menu .menu[hidden] { display:none; }
    .auth-menu .menu-header { font-size: 12px; color:#6b7280; padding: 6px 8px; }
    .auth-menu .menu-item {
      width: 100%; text-align:left; border:0; background:transparent;
      padding: 8px; border-radius: 8px; cursor:pointer;
    }
    .auth-menu .menu-item:hover { background:#f5f5f5; }
    .link--gated.is-disabled { pointer-events:none; opacity:.5; }
  `;
  const style = document.createElement('style');
  style.id = 'pw-auth-styles';
  style.textContent = css;
  document.head.appendChild(style);
})();

/* ---------- Helpers ---------- */
function getTargetHref(a) {
  // Prefer data-href for Option A; fallback to existing href
  return a?.dataset?.href || a?.getAttribute('href') || '';
}

function enableLink(a) {
  if (!a) return;
  const href = getTargetHref(a);
  if (href) a.setAttribute('href', href); // crucial for Option A
  a.setAttribute('aria-disabled', 'false');
  a.removeAttribute('title');
  a.classList.remove('is-disabled');
  a.style.pointerEvents = '';
  a.style.opacity = '';
}

function disableLink(a, title = 'Login to access') {
  if (!a) return;
  // For Option A, remove href so it’s truly not clickable while logged out
  if (a.hasAttribute('data-gated')) a.removeAttribute('href');
  a.setAttribute('aria-disabled', 'true');
  a.setAttribute('title', title);
  a.classList.add('is-disabled');
  a.style.pointerEvents = 'none';
  a.style.opacity = '0.5';
}

function isAdminOnlyLink(link) {
  if (!link) return false;
  if (link.dataset.adminOnly === 'true') return true;
  if (link.classList.contains('link--admin')) return true;
  try {
    const href = getTargetHref(link);
    const path = new URL(href, window.location.origin).pathname;
    return path.endsWith('/settings.html');
  } catch { return false; }
}

async function checkIsAdmin(user) {
  if (!user) return false;
  // 1) Custom claim
  try {
    const token = await user.getIdTokenResult();
    if (token?.claims?.admin === true) return true;
  } catch {}
  // 2) Fallback marker doc
  try {
    const snap = await getDoc(doc(db, 'admins', user.uid));
    return snap.exists();
  } catch { return false; }
}

/* ---------- Auth widget ---------- */
function initialFromUser(user) {
  const s = (user.displayName || user.email || '').trim();
  const m = s.match(/[A-Za-z0-9]/);
  return (m ? m[0] : '?').toUpperCase();
}

function renderAuthWidget(user) {
  const host = document.querySelector('.auth');
  if (!host) return;

  if (!user) {
    host.innerHTML = `
      <div class="auth-cta">
        <a class="btn btn--ghost" href="/register.html">Register</a>
        <a class="btn btn--primary" href="/login.html">Login</a>
      </div>
    `;
    return;
  }

  const name = user.displayName || user.email || 'Account';
  const initial = initialFromUser(user);

  host.innerHTML = `
    <div class="auth-menu">
      <button class="avatar-btn" aria-haspopup="menu" aria-expanded="false" title="${name}">
        <span class="avatar-circle">${initial}</span>
      </button>
      <div class="menu" role="menu" hidden>
        <div class="menu-header">${name}</div>
        <a class="menu-item" role="menuitem" href="/dashboard.html">Dashboard</a>
        <button class="menu-item" data-action="logout" role="menuitem">Log out</button>
      </div>
    </div>
  `;

  const wrap = host.querySelector('.auth-menu');
  const btn = wrap.querySelector('.avatar-btn');
  const menu = wrap.querySelector('.menu');
  const logoutBtn = wrap.querySelector('[data-action="logout"]');

  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const open  = () => { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); };
  const toggle = () => (menu.hidden ? open() : close());

  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  logoutBtn.addEventListener('click', async () => {
    try { await signOut(auth); close(); window.location.href = '/'; }
    catch (err) { console.error('Logout failed:', err); }
  });
}

/* ---------- Optional page-level guard ---------- */
function applyPageGuard(user) {
  const requires = document.body?.dataset?.requiresAuth === 'true';
  if (!requires) return;
  if (!user) {
    const next = encodeURIComponent(window.location.pathname);
    window.location.href = `/login.html?next=${next}`;
  }
}

/* ---------- Main ---------- */
async function updateNavForUser(user) {
  renderAuthWidget(user);

  const links = Array.from(document.querySelectorAll(GATED_SEL));

  if (!user) {
    links.forEach(link => disableLink(link, isAdminOnlyLink(link) ? 'Admins only' : 'Login to access'));
    applyPageGuard(null);
    window.__PW_isAdmin = false;
    return;
  }

  const isAdmin = await checkIsAdmin(user);
  window.__PW_isAdmin = isAdmin;

  links.forEach(link => {
    if (isAdminOnlyLink(link)) {
      if (isAdmin) enableLink(link);
      else disableLink(link, 'Admins only');
    } else {
      enableLink(link);
    }
  });

  applyPageGuard(user);
}

// Block clicks for gated links when disabled OR (Option A) when href is missing
document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  if (!a.matches(GATED_SEL)) return;
  const disabled = a.getAttribute('aria-disabled') === 'true';
  const noHref   = a.hasAttribute('data-gated') && !a.getAttribute('href');
  if (disabled || noHref) { e.preventDefault(); e.stopPropagation(); }
}, { capture: true });

onAuthStateChanged(auth, (user) => {
  updateNavForUser(user);
});
