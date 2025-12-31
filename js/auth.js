// /js/auth.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { 
  getFirestore,
  doc,
  setDoc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ✅ Your Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyAHl4Anfsfk-qvgspZs-BLRlbDOU6J-oK0",
  authDomain: "policyworth.firebaseapp.com",
  projectId: "policyworth",
  storageBucket: "policyworth.firebasestorage.app",
  messagingSenderId: "676966591562",
  appId: "1:676966591562:web:c1497f784e8db852690ab3",
  measurementId: "G-90M5FYCP59",
};

// Init
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Store current user profile
let currentUserProfile = null;

// Get user profile from Firestore
export async function getUserProfile(uid) {
  if (!uid) return null;
  
  try {
    const userDoc = await getDoc(doc(db, 'users', uid));
    if (userDoc.exists()) {
      currentUserProfile = userDoc.data();
      return currentUserProfile;
    }
    return null;
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return null;
  }
}

// Export current user profile getter
export function getCurrentUserProfile() {
  return currentUserProfile;
}

// --- UI helpers ------------------------------------------------------------
function setGatedLinks(enabled) {
  const gated = document.querySelectorAll(".link--gated");
  gated.forEach((a) => {
    if (enabled) {
      a.removeAttribute("aria-disabled");
      a.title = "";
      a.style.opacity = "";
      a.style.pointerEvents = "";
    } else {
      a.setAttribute("aria-disabled", "true");
      a.title = "Login to access";
      a.style.opacity = "0.45";
      a.style.pointerEvents = "none";
    }
  });
}

function showAuthedHeader(user) {
  const authWrap = document.querySelector(".auth");
  if (!authWrap) return;

  if (user) {
    authWrap.innerHTML = `<button id="logoutBtn" class="btn">Logout</button>`;
    document.getElementById("logoutBtn")?.addEventListener("click", async () => {
      await signOut(auth);
      currentUserProfile = null; // Clear profile on logout
      const url = new URL(window.location.href);
      // Protected pages (no Analysis link anymore)
      const isProtected = /dashboard|data-entry|survey|settings/.test(url.pathname);
      window.location.href = isProtected ? "/login.html" : "/";
    });
  } else {
    authWrap.innerHTML = `
      <a class="btn btn--ghost" href="/register.html">Register</a>
      <a class="btn btn--primary" href="/login.html">Login</a>
    `;
  }
}

// Keep header + gated nav in sync everywhere this script is included
onAuthStateChanged(auth, async (user) => {
  setGatedLinks(!!user);
  showAuthedHeader(user);
  
  // Load user profile when authenticated
  if (user) {
    await getUserProfile(user.uid);
  } else {
    currentUserProfile = null;
  }
});

// --- Auth form handlers ----------------------------------------------------
export async function handleRegister(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const email = form.email.value.trim();
  const password = form.password.value;
  const name = form.name?.value?.trim();
  const organization = form.organization?.value?.trim(); // ← NEW: Get organization
  const submit = form.querySelector('button[type="submit"]');
  const msg = form.querySelector("[data-msg]");

  submit.disabled = true;
  msg.textContent = "Creating your account…";

  try {
    const { user } = await createUserWithEmailAndPassword(auth, email, password);
    if (name) await updateProfile(user, { displayName: name });

    // ← NEW: Save user profile to Firestore
    await setDoc(doc(db, 'users', user.uid), {
      name: name || '',
      organization: organization || '',
      email: email,
      createdAt: new Date().toISOString(),
      role: 'user'
    });

    // Inline success state (no redirect) — links unlock via onAuthStateChanged
    const card = form.closest(".card");
    card.innerHTML = `
      <div class="eyebrow">Account created</div>
      <h3>Welcome${name ? `, ${name}` : ""}!</h3>
      <p>You're logged in now. Your navigation links are unlocked.</p>
      <div style="display:flex; gap:10px; margin-top:12px">
        <a class="btn btn--primary" href="/dashboard.html">Go to Dashboard</a>
        <a class="btn btn--ghost" href="/">Back to Home</a>
      </div>
    `;
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

export async function handleLogin(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const email = form.email.value.trim();
  const password = form.password.value;
  const submit = form.querySelector('button[type="submit"]');
  const msg = form.querySelector("[data-msg]");

  submit.disabled = true;
  msg.textContent = "Signing you in…";

  try {
    await signInWithEmailAndPassword(auth, email, password);
    // Prefer ?next= if present (from guards), otherwise go to dashboard
    const next = new URLSearchParams(window.location.search).get("next") || "/dashboard.html";
    window.location.href = next;
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}