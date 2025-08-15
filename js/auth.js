// /js/auth.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updateProfile } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyAHl4Anfsfk-qvgspZs-BLRlbDOU6J-oK0",
    authDomain: "policyworth.firebaseapp.com",
    projectId: "policyworth",
    storageBucket: "policyworth.firebasestorage.app",
    messagingSenderId: "676966591562",
    appId: "1:676966591562:web:c1497f784e8db852690ab3",
    measurementId: "G-90M5FYCP59"
  };

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// --- UI helpers ------------------------------------------------------------
function setGatedLinks(enabled) {
  const gated = document.querySelectorAll('.link--gated');
  gated.forEach(a => {
    if (enabled) {
      a.removeAttribute('aria-disabled');
      a.title = '';
      a.style.opacity = '';
      a.style.pointerEvents = '';
    } else {
      a.setAttribute('aria-disabled', 'true');
      a.title = 'Login to access';
      a.style.opacity = '0.45';
      a.style.pointerEvents = 'none';
    }
  });
}

function showAuthedHeader(user) {
  const authWrap = document.querySelector('.auth');
  if (!authWrap) return;
  if (user) {
    authWrap.innerHTML = `
      <button id="logoutBtn" class="btn">Logout</button>
    `;
    document.getElementById('logoutBtn')?.addEventListener('click', async () => {
      await signOut(auth);
      const url = new URL(window.location.href);
      const isProtected = /dashboard|data-entry|survey|analysis|settings/.test(url.pathname);
      window.location.href = isProtected ? '/login.html' : '/';
    });
  } else {
    authWrap.innerHTML = `
      <a class="btn btn--ghost" href="/register.html">Register</a>
      <a class="btn btn--primary" href="/login.html">Login</a>
    `;
  }
}

// Keep header + gated nav in sync with auth state on all pages that include this script
onAuthStateChanged(auth, (user) => {
  setGatedLinks(!!user);
  showAuthedHeader(user);
});

// --- Auth form handlers ----------------------------------------------------
export async function handleRegister(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const email = form.email.value.trim();
  const password = form.password.value;
  const name = form.name?.value?.trim();
  const submit = form.querySelector('button[type="submit"]');
  const msg = form.querySelector('[data-msg]');
  submit.disabled = true; msg.textContent = 'Creating your account…';
  try {
    const { user } = await createUserWithEmailAndPassword(auth, email, password);
    if (name) await updateProfile(user, { displayName: name });
    const next = new URLSearchParams(window.location.search).get('next') || '/dashboard.html';
    window.location.href = next;
  } catch (err) {
    msg.textContent = err.message;
  } finally { submit.disabled = false; }
}

export async function handleLogin(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const email = form.email.value.trim();
  const password = form.password.value;
  const submit = form.querySelector('button[type="submit"]');
  const msg = form.querySelector('[data-msg]');
  submit.disabled = true; msg.textContent = 'Signing you in…';
  try {
    await signInWithEmailAndPassword(auth, email, password);
    const next = new URLSearchParams(window.location.search).get('next') || '/dashboard.html';
    window.location.href = next;
  } catch (err) {
    msg.textContent = err.message;
  } finally { submit.disabled = false; }
}