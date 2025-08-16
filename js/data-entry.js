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

const STATES_URL = '/data/us-counties.json';

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
async function loadStates() {
  try {
    const res = await fetch(STATES_URL);
    stateCountyMap = await res.json();
    const states = Object.keys(stateCountyMap).sort();
    stateSel.innerHTML =
      `<option value="" disabled selected>Select a state</option>` +
      states.map((s) => `<option value="${s}">${s}</option>`).join('');
  } catch (e) {
    console.error(e);
    stateSel.innerHTML = `<option value="" disabled selected>Unable to load states</option>`;
  }
}

stateSel.addEventListener('change', () => {
  const s = stateSel.value;
  const counties = stateCountyMap[s] || [];
  if (!counties.length) {
    countySel.innerHTML = `<option value="">No counties found for ${s}</option>`;
    countySel.disabled = true;
  } else {
    countySel.innerHTML = counties.map((c) => `<option value="${c}">${c}</option>`).join('');
    countySel.disabled = false;
  }
});

let unsubscribe = null;
let currentUid = null;

onAuthStateChanged(auth, (user) => {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (!user) return; // Page should also have a separate auth-guard redirect

  currentUid = user.uid;

  const q = query(
    collection(db, 'tallies'),
    where('userId', '==', currentUid),
    orderBy('createdAt', 'desc'),
    limit(50)
  );

  unsubscribe = onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach((docSnap) => {
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

    // Restore defaults
    (function resetDate() {
      const d = new Date();
      dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate()
      ).padStart(2, '0')}`;
    })();
    serviceSel.selectedIndex = 0;
    countySel.innerHTML = `<option value="">Select a state first</option>`;
    countySel.disabled = true;
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

// Load state → county data
await loadStates();