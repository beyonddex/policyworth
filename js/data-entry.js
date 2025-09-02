// /js/data-entry.js
// Firestore-backed Data Entry (per-user)
// Requires: export const db, auth in /js/auth.js
// Page must include: <script type="module" src="/js/auth.js"></script>

import { auth, db } from '/js/auth.js';
import {
  collection,
  addDoc,
  serverTimestamp,
  query,
  orderBy,
  limit,
  onSnapshot,
  deleteDoc,
  doc,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const STATES_URL = '/data/states-counties.json'; // Florida-only JSON

// ---------- DOM helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);

const form = $('#tallyForm');
const stateSel = $('#state');
const countySel = $('#county');
const dateInput = $('#date');
const serviceSel = $('#service');
const yesInput = $('#yes');
const noInput = $('#no');
const msg = $('#msg');
const tbody = document.querySelector('#entriesTable tbody');
const emptyState = $('#emptyState');

if (!form || !stateSel || !countySel || !dateInput || !serviceSel || !yesInput || !noInput || !tbody) {
  console.warn('[data-entry] Missing one or more required DOM elements.');
}

// ---------- Default date = today ----------
(function initDate() {
  const d = new Date();
  dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

// ---------- Firestore path helper (per-user subcollection) ----------
function userTalliesCol(uid) {
  return collection(db, 'users', uid, 'tallies');
}

// ---------- Pretty labels for service codes ----------
const SERVICE_LABELS = {
  case_mgmt: 'Case Management',
  hdm: 'Home-Delivered Meals',
  caregiver_respite: 'Caregiver/Respite',
  crisis_intervention: 'Crisis Intervention',
};
const serviceLabel = (code) => SERVICE_LABELS[code] ?? code ?? '';

// ---------- Prefs (remember last state/county/service) ----------
let currentUid = null;
const GLOBAL_KEY = 'pw_last_loc_global';
const prefsKey = () => (currentUid ? `pw_last_loc_${currentUid}` : GLOBAL_KEY);

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(prefsKey()) || 'null'); } catch { return null; }
}
function savePrefs(state, county, service) {
  try { localStorage.setItem(prefsKey(), JSON.stringify({ state, county, service })); } catch {}
}
function optionExistsInSelect(selectEl, value) {
  if (!value) return false;
  return Array.from(selectEl.options).some(opt => opt.value === value);
}
function applyPrefsIfValid() {
  const prefs = loadPrefs();
  if (!prefs) return false;

  // Apply state + counties
  if (prefs.state && stateCountyMap[prefs.state]) {
    stateSel.value = prefs.state;
    populateCounties(prefs.state);
    if (prefs.county && stateCountyMap[prefs.state].includes(prefs.county)) {
      countySel.value = prefs.county;
    }
  }

  // Apply service if it exists in the select
  if (optionExistsInSelect(serviceSel, prefs.service)) {
    serviceSel.value = prefs.service;
  }

  return true;
}

// ---------- State/County ----------
let stateCountyMap = {};
let defaultState = null;
let statesLoaded = false;

async function loadStates() {
  if (statesLoaded) return; // prevent double work
  console.log('[data-entry] Loading states from', STATES_URL);
  try {
    const res = await fetch(STATES_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to load ${STATES_URL}`);
    stateCountyMap = await res.json();

    const states = Object.keys(stateCountyMap).sort();
    stateSel.innerHTML =
      `<option value="" disabled ${states.length !== 1 ? 'selected' : ''}>Select a state</option>` +
      states.map((s) => `<option value="${s}">${s}</option>`).join('');

    // 1) Try applying saved prefs first (per-user if signed in)
    const applied = applyPrefsIfValid();
    if (applied) {
      console.log('[data-entry] Applied saved state/county/service from localStorage.');
    } else if (states.length === 1) {
      // 2) Else if single state, preselect it
      defaultState = states[0];
      stateSel.value = defaultState;
      populateCounties(defaultState);
    } else {
      // 3) Else require selection
      stateSel.selectedIndex = 0;
      countySel.innerHTML = `<option value="">Select a state first</option>`;
      countySel.disabled = true;
    }

    statesLoaded = true;
    console.log('[data-entry] States loaded:', states.length);
  } catch (e) {
    console.error('[data-entry] loadStates error:', e);
    stateSel.innerHTML = `<option value="" disabled selected>Unable to load states</option>`;
    countySel.innerHTML = `<option value="">—</option>`;
    countySel.disabled = true;
  }
}

function populateCounties(stateName) {
  const counties = stateCountyMap[stateName] || [];
  if (!counties.length) {
    countySel.innerHTML = `<option value="">No counties found for ${stateName}</option>`;
    countySel.disabled = true;
  } else {
    countySel.innerHTML = counties.map((c) => `<option value="${c}">${c}</option>`).join('');
    countySel.disabled = false;
  }
}

stateSel?.addEventListener('change', () => {
  populateCounties(stateSel.value);
  countySel.selectedIndex = 0; // clear county when state changes
  // We persist on submit to reflect actual entries.
});

// ---------- Recent Entries (server-side sorted listener) ----------
let unsubscribe = null;

function renderRows(snapshot) {
  const rows = [];
  snapshot.forEach((docSnap) => {
    const e = docSnap.data() || {};
    const id = docSnap.id;

    // Graceful timestamp display
    let added = '';
    if (e.createdAt && typeof e.createdAt.toDate === 'function') {
      try { added = e.createdAt.toDate().toLocaleString(); } catch {}
    } else if (e.createdAtMs) {
      try { added = new Date(e.createdAtMs).toLocaleString(); } catch {}
    }

    rows.push(`
      <tr data-id="${id}">
        <td>${e.date ?? ''}</td>
        <td>${e.state ?? ''}</td>
        <td>${e.county ?? ''}</td>
        <td>${serviceLabel(e.service)}</td>
        <td>${e.yes ?? 0}</td>
        <td>${e.no ?? 0}</td>
        <td>${added}</td>
        <td style="text-align:right"><button class="btn" data-del>Delete</button></td>
      </tr>
    `);
  });

  tbody.innerHTML = rows.join('');
  emptyState.style.display = rows.length ? 'none' : 'block';

  console.log(`[data-entry] renderRows: ${rows.length} row(s)`);
}

function attachListenerForUser(uid) {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  console.log('[data-entry] Attaching listener for uid:', uid);

  const qRef = query(
    userTalliesCol(uid),
    orderBy('createdAt', 'desc'), // pure server-side sort
    limit(50)
  );

  unsubscribe = onSnapshot(
    qRef,
    (snap) => {
      console.log('[data-entry] onSnapshot received:', snap.size, 'docs');
      renderRows(snap);
    },
    (err) => {
      console.error('[data-entry] onSnapshot error:', err);
      msg.textContent = err?.message || 'Failed to load recent entries.';
    }
  );
}

onAuthStateChanged(auth, async (user) => {
  console.log('[data-entry] onAuthStateChanged:', !!user);

  if (unsubscribe) { unsubscribe(); unsubscribe = null; }

  if (!user) {
    currentUid = null;
    await loadStates();      // ensure states are available for logged-out too
    applyPrefsIfValid();     // apply global prefs (if any)
    tbody.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }

  currentUid = user.uid;
  await loadStates();        // guarded (won’t re-fetch if already loaded)
  applyPrefsIfValid();       // now applies per-user prefs
  attachListenerForUser(currentUid);
});

// ---------- Submit / Add Doc ----------
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUid) { msg.textContent = 'Please sign in.'; return; }

  const entry = {
    userId: currentUid, // still storing for admin tooling/search
    date: dateInput.value,
    state: stateSel.value,
    county: countySel.value,
    service: serviceSel.value,
    yes: Number(yesInput.value || 0),
    no: Number(noInput.value || 0),
    createdAt: serverTimestamp(), // ordered field (indexed)
    createdAtMs: Date.now(),      // display fallback
  };

  if (!entry.state || !entry.county) {
    msg.textContent = 'Please select a state and county.';
    return;
  }

  try {
    console.log('[data-entry] Adding doc:', entry);
    await addDoc(userTalliesCol(currentUid), entry);
    msg.textContent = 'Saved.';

    // ✅ Remember last selection AFTER a successful save (state/county/service)
    savePrefs(entry.state, entry.county, entry.service);

    // Reset quick fields only; KEEP saved state/county/service for rapid add
    form.reset();

    // Reapply date to today
    const d = new Date();
    dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    // Re-apply saved state/county/service (do not force defaults)
    applyPrefsIfValid();

    // Reset only the fields that change often
    yesInput.value = '0';
    noInput.value = '0';
  } catch (err) {
    console.error('[data-entry] addDoc error:', err);
    msg.textContent = err.message;
  }
});

// ---------- Row deletion (event delegation) ----------
document.querySelector('#entriesTable')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const id = tr?.dataset?.id;
  if (!id) return;

  try {
    console.log('[data-entry] Deleting doc id:', id);
    await deleteDoc(doc(db, 'users', currentUid, 'tallies', id));
  } catch (err) {
    console.error('[data-entry] deleteDoc error:', err);
    alert(err.message);
  }
});

// ---------- Boot ----------
(async () => {
  try {
    await loadStates(); // first load for logged-out view; guarded if authed later
  } catch (err) {
    // already logged inside loadStates
  }

  // Optional sanity log to confirm query will work once authed
  if (currentUid) {
    try {
      const sanity = await getDocs(
        query(userTalliesCol(currentUid), orderBy('createdAt', 'desc'), limit(1))
      );
      console.log('[data-entry] Sanity check docs:', sanity.size);
    } catch (err) {
      console.warn('[data-entry] Sanity check error:', err.message);
    }
  }
})();
