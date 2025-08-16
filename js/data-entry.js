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
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const STATES_URL = '/data/states-counties.json'; // ← Florida-only JSON

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

// Default date = today
(function initDate() {
  const d = new Date();
  dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
})();

let stateCountyMap = {};
let defaultState = null;

async function loadStates() {
  try {
    const res = await fetch(STATES_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to load ${STATES_URL}`);
    stateCountyMap = await res.json();

    const states = Object.keys(stateCountyMap).sort();
    stateSel.innerHTML =
      `<option value="" disabled>Select a state</option>` +
      states.map((s) => `<option value="${s}">${s}</option>`).join('');

    // Auto-select if only Florida exists
    if (states.length === 1) {
      defaultState = states[0];
      stateSel.value = defaultState;
      populateCounties(defaultState);
    } else {
      stateSel.selectedIndex = 0;
      countySel.innerHTML = `<option value="">Select a state first</option>`;
      countySel.disabled = true;
    }
  } catch (e) {
    console.error(e);
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

stateSel.addEventListener('change', () => {
  populateCounties(stateSel.value);
});

let unsubscribe = null;
let currentUid = null;

function renderRows(snapshot) {
  const rows = [];
  snapshot.forEach((docSnap) => {
    const e = docSnap.data();
    const id = docSnap.id;
    const added = e.createdAt?.toDate ? e.createdAt.toDate().toLocaleString() : '';
    rows.push(
      `<tr data-id="${id}">
        <td>${e.date}</td>
        <td>${e.state}</td>
        <td>${e.county}</td>
        <td>${e.service}</td>
        <td>${e.yes}</td>
        <td>${e.no}</td>
        <td>${added}</td>
        <td style="text-align:right"><button class="btn" data-del>Delete</button></td>
      </tr>`
    );
  });
  tbody.innerHTML = rows.join('');
  emptyState.style.display = rows.length ? 'none' : 'block';
}

onAuthStateChanged(auth, (user) => {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (!user) return;

  currentUid = user.uid;

  const q = query(
    collection(db, 'tallies'),
    where('userId', '==', currentUid),
    orderBy('createdAt', 'desc'),
    limit(50)
  );

  unsubscribe = onSnapshot(q, (snap) => {
    renderRows(snap);
  });
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUid) return;

  const entry = {
    userId: currentUid,
    date: dateInput.value,
    state: stateSel.value,
    county: countySel.value,
    service: serviceSel.value,
    yes: Number(yesInput.value || 0),
    no: Number(noInput.value || 0),
    createdAt: serverTimestamp(),
  };

  if (!entry.state || !entry.county) {
    msg.textContent = 'Please select a state and county.';
    return;
  }

  try {
    await addDoc(collection(db, 'tallies'), entry);
    msg.textContent = 'Saved.';
    form.reset();

    // Reset defaults
    const d = new Date();
    dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;

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
    console.error(err);
    msg.textContent = err.message;
  }
});

// Row deletion (event delegation)
document.querySelector('#entriesTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const id = tr?.dataset?.id;
  if (!id) return;
  try {
    await deleteDoc(doc(db, 'tallies', id));
  } catch (err) {
    console.error(err);
    alert(err.message);
  }
});

// Load states/counties
await loadStates();
