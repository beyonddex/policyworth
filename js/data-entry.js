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
  where,
  orderBy,
  limit,
  onSnapshot,
  deleteDoc,
  doc,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const STATES_URL = '/data/states-counties.json'; // ← Florida-only JSON

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

// ---------- State/County ----------
let stateCountyMap = {};
let defaultState = null;

async function loadStates() {
  console.log('[data-entry] Loading states from', STATES_URL);
  try {
    const res = await fetch(STATES_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to load ${STATES_URL}`);
    stateCountyMap = await res.json();

    const states = Object.keys(stateCountyMap).sort();
    stateSel.innerHTML =
      `<option value="" disabled ${states.length !== 1 ? 'selected' : ''}>Select a state</option>` +
      states.map((s) => `<option value="${s}">${s}</option>`).join('');

    if (states.length === 1) {
      defaultState = states[0];
      stateSel.value = defaultState;
      populateCounties(defaultState);
    } else {
      stateSel.selectedIndex = 0;
      countySel.innerHTML = `<option value="">Select a state first</option>`;
      countySel.disabled = true;
    }

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
});

// ---------- Recent Entries (listener) ----------
let unsubscribe = null;
let currentUid = null;

function renderRows(snapshot) {
  const rows = [];
  snapshot.forEach((docSnap) => {
    const e = docSnap.data() || {};
    const id = docSnap.id;

    // Graceful timestamp display
    let added = '';
    if (e.createdAt && typeof e.createdAt.toDate === 'function') {
      try {
        added = e.createdAt.toDate().toLocaleString();
      } catch (err) {
        // no-op
      }
    } else if (e.createdAtMs) {
      try {
        added = new Date(e.createdAtMs).toLocaleString();
      } catch (err) {
        // no-op
      }
    }

    rows.push(`
      <tr data-id="${id}">
        <td>${e.date ?? ''}</td>
        <td>${e.state ?? ''}</td>
        <td>${e.county ?? ''}</td>
        <td>${e.service ?? ''}</td>
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
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  console.log('[data-entry] Attaching listener for uid:', uid);

  const qRef = query(
    collection(db, 'tallies'),
    where('userId', '==', uid),
    orderBy('createdAt', 'desc'),
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
      // If an index is needed, Firestore usually prints a "Create index" link in the console.
    }
  );
}

onAuthStateChanged(auth, async (user) => {
  console.log('[data-entry] onAuthStateChanged:', !!user);
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (!user) {
    currentUid = null;
    tbody.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }
  currentUid = user.uid;
  attachListenerForUser(currentUid);
});

// ---------- Submit / Add Doc ----------
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUid) {
    msg.textContent = 'Please sign in.';
    return;
  }

  const entry = {
    userId: currentUid,
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
    await addDoc(collection(db, 'tallies'), entry);
    msg.textContent = 'Saved.';

    // Reset form
    form.reset();

    // Reset defaults
    const d = new Date();
    dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    if (defaultState) {
      stateSel.value = defaultState;
      populateCounties(defaultState);
    } else {
      stateSel.selectedIndex = 0;
      countySel.innerHTML = `<option value="">Select a state first</option>`;
      countySel.disabled = true;
    }

    serviceSel.selectedIndex = 0;
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
    await deleteDoc(doc(db, 'tallies', id));
  } catch (err) {
    console.error('[data-entry] deleteDoc error:', err);
    alert(err.message);
  }
});

// ---------- Boot ----------
(async () => {
  try {
    await loadStates();
  } catch (err) {
    // already logged inside loadStates
  }

  // Optional sanity log to confirm query will work once authed
  if (currentUid) {
    try {
      const sanity = await getDocs(
        query(
          collection(db, 'tallies'),
          where('userId', '==', currentUid),
          orderBy('createdAt', 'desc'),
          limit(1)
        )
      );
      console.log('[data-entry] Sanity check docs:', sanity.size);
    } catch (err) {
      console.warn('[data-entry] Sanity check error (likely needs index):', err.message);
    }
  }
})();
