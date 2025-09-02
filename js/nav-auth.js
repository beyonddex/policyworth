// /js/nav-auth.js
// Locks/unlocks gated nav links based on auth + admin
// Include on any page with the site header/nav:
//   <script type="module" src="/js/nav-auth.js"></script>

import { auth, db } from '/js/auth.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const GATED_SEL = '.link--gated';

// ---- Helpers ---------------------------------------------------------------

function setGate(link, enabled, disabledTitle = 'Login to access') {
  if (!link) return;
  if (enabled) {
    link.setAttribute('aria-disabled', 'false');
    link.removeAttribute('title');
    link.classList.remove('is-disabled');
    link.style.pointerEvents = '';
    link.style.opacity = '';
  } else {
    link.setAttribute('aria-disabled', 'true');
    link.setAttribute('title', disabledTitle);
    link.classList.add('is-disabled');
    // keep it obviously non-clickable even if CSS is missing
    link.style.pointerEvents = 'none';
    link.style.opacity = '0.5';
  }
}

// Block clicks when aria-disabled=true (works even if CSS is overridden)
function installClickBlocker(root = document) {
  root.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    if (a.matches(GATED_SEL) && a.getAttribute('aria-disabled') === 'true') {
      e.preventDefault();
      e.stopPropagation();
    }
  }, { capture: true });
}

function isAdminOnlyLink(link) {
  if (!link) return false;
  if (link.dataset.adminOnly === 'true') return true;
  if (link.classList.contains('link--admin')) return true;
  try {
    const href = new URL(link.getAttribute('href'), window.location.origin).pathname;
    return href.endsWith('/settings.html');
  } catch {
    return false;
  }
}

async function checkIsAdmin(user) {
  if (!user) return false;

  // 1) Custom claim (fast path)
  try {
    const token = await user.getIdTokenResult();
    if (token?.claims?.admin === true) return true;
  } catch {}

  // 2) Fallback: existence of /admins/{uid}
  try {
    const snap = await getDoc(doc(db, 'admins', user.uid));
    return snap.exists();
  } catch {
    return false;
  }
}

function updateAuthWidget(user) {
  const host = document.querySelector('.auth');
  if (!host) return;

  if (!user) {
    host.innerHTML = `<a class="btn" href="/login.html">Log in</a>`;
    return;
  }
  const name = user.displayName || user.email || 'Signed in';
  host.innerHTML = `<span class="muted">${name}</span>`;
}

// Optional: page-level guard if you prefer data attributes over inline scripts.
// Add on any page that must require auth: <body data-requires-auth="true">
function applyPageGuard(user) {
  const requires = document.body?.dataset?.requiresAuth === 'true';
  if (!requires) return;

  if (!user) {
    const next = encodeURIComponent(window.location.pathname);
    window.location.href = `/login.html?next=${next}`;
  }
}

// ---- Main ------------------------------------------------------------------

installClickBlocker();

async function updateNavForUser(user) {
  updateAuthWidget(user);

  const links = Array.from(document.querySelectorAll(GATED_SEL));

  if (!user) {
    // Logged out → everything gated
    links.forEach(link => {
      const title = isAdminOnlyLink(link) ? 'Admins only' : 'Login to access';
      setGate(link, false, title);
    });
    // If you’re using the optional page guard:
    applyPageGuard(null);
    window.__PW_isAdmin = false;
    return;
  }

  // Logged in → unlock general gated links; check admin for admin-only links
  const isAdmin = await checkIsAdmin(user);
  window.__PW_isAdmin = isAdmin; // handy for debugging in DevTools

  links.forEach(link => {
    if (isAdminOnlyLink(link)) {
      setGate(link, isAdmin, 'Admins only');
    } else {
      setGate(link, true);
    }
  });

  // Optional page guard
  applyPageGuard(user);
}

onAuthStateChanged(auth, (user) => {
  updateNavForUser(user);
});
