// /js/data-entry.js
// Firestore-backed Data Entry (per-user)

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
  getDoc,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const STATES_URL = '/data/states-counties.json';

// ---------- DOM helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);

// Left form
const form = $('#tallyForm');
const stateSel = $('#state');
const countySel = $('#county');
const dateInput = $('#date');
const serviceSel = $('#service');
const avgCostInput = $('#avgCostYear'); // read-only mirror
const yesInput = $('#yes');
const noInput = $('#no');
const msg = $('#msg');

// Right sidebar (per-user service costs editor)
const cost_case_mgmt = $('#cost_case_mgmt');
const cost_hdm = $('#cost_hdm');
const cost_caregiver_respite = $('#cost_caregiver_respite');
const cost_crisis_intervention = $('#cost_crisis_intervention');
const saveCostsBtn = $('#saveCostsBtn');
const costsMsg = $('#costsMsg');

// Table
const tbody = document.querySelector('#entriesTable tbody');
const emptyState = $('#emptyState');

if (!form || !stateSel || !countySel || !dateInput || !serviceSel || !avgCostInput || !yesInput || !noInput || !tbody) {
  console.warn('[data-entry] Missing one or more required DOM elements.');
}

// ---------- Default date = today ----------
(function initDate() {
  const d = new Date();
  dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

// ---------- Firestore paths ----------
function userTalliesCol(uid) {
  return collection(db, 'users', uid, 'tallies');
}
function userServiceCostsDoc(uid) {
  return doc(db, 'users', uid, 'meta', 'serviceCosts');
}

// ---------- Service labels ----------
const SERVICE_LABELS = {
  case_mgmt: 'Case Management',
  hdm: 'Home-Delivered Meals',
  caregiver_respite: 'Caregiver/Respite',
  crisis_intervention: 'Crisis Intervention',
};
const serviceLabel = (code) => SERVICE_LABELS[code] ?? code ?? '';

// ---------- Per-user service costs (right panel) ----------
let serviceCosts = {
  case_mgmt: 0,
  hdm: 0,
  caregiver_respite: 0,
  crisis_intervention: 0,
};

function clampNonNeg(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

function fillRightPanelFromState() {
  if (cost_case_mgmt) cost_case_mgmt.value = serviceCosts.case_mgmt ?? 0;
  if (cost_hdm) cost_hdm.value = serviceCosts.hdm ?? 0;
  if (cost_caregiver_respite) cost_caregiver_respite.value = serviceCosts.caregiver_respite ?? 0;
  if (cost_crisis_intervention) cost_crisis_intervention.value = serviceCosts.crisis_intervention ?? 0;
}

function syncAvgCostFromSaved() {
  const code = serviceSel?.value;
  if (!code) return;
  const v = clampNonNeg(serviceCosts[code]);
  avgCostInput.value = String(v);
}

async function loadServiceCosts(uid) {
  if (!uid) return;
  try {
    const snap = await getDoc(userServiceCostsDoc(uid));
    if (snap.exists()) {
      const d = snap.data() || {};
      serviceCosts = {
        case_mgmt: clampNonNeg(d.case_mgmt),
        hdm: clampNonNeg(d.hdm),
        caregiver_respite: clampNonNeg(d.caregiver_respite),
        crisis_intervention: clampNonNeg(d.crisis_intervention),
      };
    } else {
      // If no doc, keep zeros (user can enter and save)
      serviceCosts = { case_mgmt: 0, hdm: 0, caregiver_respite: 0, crisis_intervention: 0 };
    }
    fillRightPanelFromState();
    syncAvgCostFromSaved();
  } catch (e) {
    console.error('[data-entry] loadServiceCosts error:', e);
  }
}

async function saveServiceCosts(uid) {
  if (!uid) { if (costsMsg) costsMsg.textContent = 'Please sign in.'; return; }
  const payload = {
    case_mgmt: clampNonNeg(cost_case_mgmt?.value),
    hdm: clampNonNeg(cost_hdm?.value),
    caregiver_respite: clampNonNeg(cost_caregiver_respite?.value),
    crisis_intervention: clampNonNeg(cost_crisis_intervention?.value),
    updatedAt: serverTimestamp(),
  };
  try {
    await setDoc(userServiceCostsDoc(uid), payload, { merge: true });
    // Update local cache and mirror to left field
    serviceCosts = {
      case_mgmt: payload.case_mgmt,
      hdm: payload.hdm,
      caregiver_respite: payload.caregiver_respite,
      crisis_intervention: payload.crisis_intervention,
    };
    syncAvgCostFromSaved();
    if (costsMsg) {
      costsMsg.textContent = 'Saved.';
      setTimeout(() => { if (costsMsg.textContent === 'Saved.') costsMsg.textContent = ''; }, 2000);
    }
  } catch (e) {
    console.error('[data-entry] saveServiceCosts error:', e);
    if (costsMsg) costsMsg.textContent = e?.message || 'Save failed.';
  }
}

saveCostsBtn?.addEventListener('click', () => saveServiceCosts(currentUid));

// When the service changes, mirror the saved cost (do NOT enforce any special 0 rules)
serviceSel?.addEventListener('change', () => {
  syncAvgCostFromSaved();
});

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

  if (prefs.state && stateCountyMap[prefs.state]) {
    stateSel.value = prefs.state;
    populateCounties(prefs.state);
    if (prefs.county && stateCountyMap[prefs.state].includes(prefs.county)) {
      countySel.value = prefs.county;
    }
  }
  if (optionExistsInSelect(serviceSel, prefs.service)) {
    serviceSel.value = prefs.service;
  }
  // Left field mirrors whatever is saved for selected service
  syncAvgCostFromSaved();
  return true;
}

// ---------- State/County ----------
let stateCountyMap = {};
let defaultState = null;
let statesLoaded = false;

async function loadStates() {
  if (statesLoaded) return;
  try {
    const res = await fetch(STATES_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to load ${STATES_URL}`);
    stateCountyMap = await res.json();

    const states = Object.keys(stateCountyMap).sort();
    stateSel.innerHTML =
      `<option value="" disabled ${states.length !== 1 ? 'selected' : ''}>Select a state</option>` +
      states.map((s) => `<option value="${s}">${s}</option>`).join('');

    const applied = applyPrefsIfValid();
    if (!applied) {
      if (states.length === 1) {
        defaultState = states[0];
        stateSel.value = defaultState;
        populateCounties(defaultState);
      } else {
        stateSel.selectedIndex = 0;
        countySel.innerHTML = `<option value="">Select a state first</option>`;
        countySel.disabled = true;
      }
    }

    statesLoaded = true;
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
  countySel.selectedIndex = 0;
});

// ---------- Recent Entries (server-side sorted listener) ----------
let unsubscribe = null;

function formatCurrency(n) {
  const num = typeof n === 'number' ? n : Number(n);
  if (!isFinite(num)) return '';
  try {
    return num.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  } catch {
    return `$${Math.round(num).toLocaleString()}`;
  }
}

function renderRows(snapshot) {
  const rows = [];
  snapshot.forEach((docSnap) => {
    const e = docSnap.data() || {};
    const id = docSnap.id;

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
        <td>${formatCurrency(e.avgCostYear)}</td>
        <td>${e.yes ?? 0}</td>
        <td>${e.no ?? 0}</td>
        <td>${added}</td>
        <td style="text-align:right"><button class="btn" data-del>Delete</button></td>
      </tr>
    `);
  });

  tbody.innerHTML = rows.join('');
  emptyState.style.display = rows.length ? 'none' : 'block';
}

function attachListenerForUser(uid) {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }

  const qRef = query(
    userTalliesCol(uid),
    orderBy('createdAt', 'desc'),
    limit(50)
  );

  unsubscribe = onSnapshot(
    qRef,
    (snap) => renderRows(snap),
    (err) => {
      console.error('[data-entry] onSnapshot error:', err);
      msg.textContent = err?.message || 'Failed to load recent entries.';
    }
  );
}

// ---------- Auth flow ----------
onAuthStateChanged(auth, async (user) => {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }

  if (!user) {
    currentUid = null;
    await loadStates();      // still load states for layout
    // Reset costs panel to zeros (read-only left will mirror 0)
    serviceCosts = { case_mgmt: 0, hdm: 0, caregiver_respite: 0, crisis_intervention: 0 };
    fillRightPanelFromState();
    syncAvgCostFromSaved();

    tbody.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }

  currentUid = user.uid;
  await loadStates();              // populate selects
  await loadServiceCosts(currentUid); // load costs and mirror to left
  applyPrefsIfValid();             // may set service; mirror runs again inside
  attachListenerForUser(currentUid);
});

// ---------- Submit / Add Doc ----------
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUid) { msg.textContent = 'Please sign in.'; return; }

  const entry = {
    userId: currentUid,
    date: dateInput.value,
    state: stateSel.value,
    county: countySel.value,
    service: serviceSel.value,
    avgCostYear: clampNonNeg(avgCostInput.value), // from read-only mirror
    yes: Number(yesInput.value || 0),
    no: Number(noInput.value || 0),
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
  };

  if (!entry.state || !entry.county) {
    msg.textContent = 'Please select a state and county.';
    return;
  }

  try {
    await addDoc(userTalliesCol(currentUid), entry);
    msg.textContent = 'Saved.';

    // Remember last selection AFTER a successful save
    savePrefs(entry.state, entry.county, entry.service);

    // Keep state/county/service & avg cost; reset fast-changing fields
    const d = new Date();
    dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    await deleteDoc(doc(db, 'users', currentUid, 'tallies', id));
  } catch (err) {
    console.error('[data-entry] deleteDoc error:', err);
    alert(err.message);
  }
});

// ---------- Boot ----------
(async () => {
  try {
    await loadStates();
  } catch {}
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
