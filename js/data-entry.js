// /js/data-entry.js
// Firestore-backed Data Entry (per-user) with per-location service costs

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

/* ---------------- DOM helpers ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);

/* LEFT: Add Tally form */
const form = $('#tallyForm');
const stateSel = $('#state');
const countySel = $('#county');
const dateInput = $('#date');
const serviceSel = $('#service');
const avgCostInput = $('#avgCostYear'); // read-only mirror
const yesInput = $('#yes');
const noInput = $('#no');
const msg = $('#msg');

/* RIGHT: Location-specific editor + navigator */
const costStateSel = $('#costState');
const costCountySel = $('#costCounty');
const costUseCurrentBtn = $('#costUseCurrent');

const loc_cost_case_mgmt = $('#loc_cost_case_mgmt');
const loc_cost_hdm = $('#loc_cost_hdm');
const loc_cost_caregiver_respite = $('#loc_cost_caregiver_respite');
const loc_cost_crisis_intervention = $('#loc_cost_crisis_intervention');

const costSaveBtn = $('#costSaveBtn');
const costsMsg = $('#costsMsg');

const savedListEl = $('#savedList');
const savedCountEl = $('#savedCount');
const costFilter = $('#costFilter');

/* Table */
const tbody = document.querySelector('#entriesTable tbody');
const emptyState = $('#emptyState');

if (!form || !stateSel || !countySel || !dateInput || !serviceSel || !avgCostInput || !yesInput || !noInput || !tbody) {
  console.warn('[data-entry] Missing one or more required DOM elements.');
}

/* ---------------- Default date = today ---------------- */
(function initDate() {
  const d = new Date();
  dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

/* ---------------- Paths & utils ---------------- */
function userTalliesCol(uid) {
  return collection(db, 'users', uid, 'tallies');
}
function userServiceCostsByCountyCol(uid) {
  return collection(db, 'users', uid, 'meta', 'serviceCostsByCounty');
}
function userServiceCostDoc(uid, docId) {
  return doc(db, 'users', uid, 'meta', 'serviceCostsByCounty', docId);
}

function slugCounty(county = '') {
  return String(county).trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function locDocId(stateName, countyName) {
  return `${String(stateName || '').toUpperCase()}__${slugCounty(countyName || '')}`;
}
function clampNonNegInt(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

/* ---------------- Service labels ---------------- */
const SERVICE_LABELS = {
  case_mgmt: 'Case Management',
  hdm: 'Home-Delivered Meals',
  caregiver_respite: 'Caregiver/Respite',
  crisis_intervention: 'Crisis Intervention',
};
const serviceLabel = (code) => SERVICE_LABELS[code] ?? code ?? '';

/* ---------------- State/County data ---------------- */
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

    // Left: state select
    stateSel.innerHTML =
      `<option value="" disabled ${states.length !== 1 ? 'selected' : ''}>Select a state</option>` +
      states.map((s) => `<option value="${s}">${s}</option>`).join('');

    // Right: editor's state select mirrors the same states
    if (costStateSel) {
      costStateSel.innerHTML = states.map((s) => `<option value="${s}">${s}</option>`).join('');
    }

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

function populateEditorCounties(stateName) {
  if (!costCountySel) return;
  const counties = stateCountyMap[stateName] || [];
  costCountySel.innerHTML = counties.map((c) => `<option value="${c}">${c}</option>`).join('');
}

/* ---------------- Prefs (remember last state/county/service) ---------------- */
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

  // Mirror left avg cost from location-specific cache
  syncLeftAvgCostFromLocation();
  return true;
}

/* ---------------- Per-location service costs (right) ---------------- */
// Cache of user’s saved location costs keyed by docId
// { DOCID: { state, county, case_mgmt, hdm, caregiver_respite, crisis_intervention, createdAt?, updatedAt? } }
let locationCosts = {};
let costsUnsub = null;

// Current editor location
let editorState = null;
let editorCounty = null;

function getLeftDocId() {
  const st = stateSel?.value || '';
  const ct = countySel?.value || '';
  if (!st || !ct) return null;
  return locDocId(st, ct);
}

function getEditorDocId() {
  if (!editorState || !editorCounty) return null;
  return locDocId(editorState, editorCounty);
}

function fillEditorInputsFromCache() {
  const id = getEditorDocId();
  const data = id ? locationCosts[id] : null;

  const vals = {
    case_mgmt: data?.case_mgmt ?? 0,
    hdm: data?.hdm ?? 0,
    caregiver_respite: data?.caregiver_respite ?? 0,
    crisis_intervention: data?.crisis_intervention ?? 0,
  };

  if (loc_cost_case_mgmt) loc_cost_case_mgmt.value = vals.case_mgmt;
  if (loc_cost_hdm) loc_cost_hdm.value = vals.hdm;
  if (loc_cost_caregiver_respite) loc_cost_caregiver_respite.value = vals.caregiver_respite;
  if (loc_cost_crisis_intervention) loc_cost_crisis_intervention.value = vals.crisis_intervention;
}

function setEditorLocation(stateName, countyName) {
  if (!stateName) return;

  editorState = stateName;
  if (costStateSel) costStateSel.value = editorState;

  populateEditorCounties(editorState);

  // If provided county exists, select it; otherwise pick first county if any
  const counties = stateCountyMap[editorState] || [];
  if (countyName && counties.includes(countyName)) {
    editorCounty = countyName;
  } else {
    editorCounty = counties[0] || null;
  }
  if (costCountySel) costCountySel.value = editorCounty || '';

  fillEditorInputsFromCache();
}

function renderSavedList() {
  if (!savedListEl) return;

  const filterText = (costFilter?.value || '').toLowerCase();
  const items = Object.values(locationCosts).map(v => ({
    state: v.state || '',
    county: v.county || '',
    id: locDocId(v.state || '', v.county || ''),
    setCount: ['case_mgmt','hdm','caregiver_respite','crisis_intervention']
      .reduce((n,k)=> n + (typeof v[k] === 'number' && v[k] >= 0 ? 1 : 0), 0),
  }));

  const filtered = items
    .filter(it => !filterText ||
      it.state.toLowerCase().includes(filterText) ||
      it.county.toLowerCase().includes(filterText))
    .sort((a,b) => a.state.localeCompare(b.state) || a.county.localeCompare(b.county));

  savedListEl.innerHTML = filtered.map(it => `
    <button class="saved-item" data-state="${it.state}" data-county="${it.county}">
      <div>
        <div class="name">${it.county}</div>
        <div class="sub">${it.state}</div>
      </div>
      <span class="pill">${it.setCount} set</span>
    </button>
  `).join('');

  if (savedCountEl) savedCountEl.textContent = filtered.length ? `(${filtered.length})` : '';
}

function syncLeftAvgCostFromLocation() {
  const st = stateSel?.value;
  const ct = countySel?.value;
  const svc = serviceSel?.value;
  if (!st || !ct || !svc) { avgCostInput.value = '0'; return; }

  const id = locDocId(st, ct);
  const entry = locationCosts[id];
  const value = entry && typeof entry[svc] === 'number' ? entry[svc] : 0;
  avgCostInput.value = String(clampNonNegInt(value));
}

async function saveEditorLocationCosts() {
  if (!currentUid) { if (costsMsg) costsMsg.textContent = 'Please sign in.'; return; }
  if (!editorState || !editorCounty) { if (costsMsg) costsMsg.textContent = 'Pick a state & county.'; return; }

  const id = getEditorDocId();
  if (!id) return;

  const payload = {
    state: editorState,
    county: editorCounty,
    case_mgmt: clampNonNegInt(loc_cost_case_mgmt?.value),
    hdm: clampNonNegInt(loc_cost_hdm?.value),
    caregiver_respite: clampNonNegInt(loc_cost_caregiver_respite?.value),
    crisis_intervention: clampNonNegInt(loc_cost_crisis_intervention?.value),
    updatedAt: serverTimestamp(),
  };

  try {
    // createdAt on first write
    const ref = userServiceCostDoc(currentUid, id);
    const existing = await getDoc(ref);
    await setDoc(ref, existing.exists() ? payload : { ...payload, createdAt: serverTimestamp() }, { merge: true });

    costsMsg.textContent = 'Saved.';
    setTimeout(() => { if (costsMsg.textContent === 'Saved.') costsMsg.textContent = ''; }, 2000);

    // If this editor location matches the left form selection, mirror immediately
    const leftId = getLeftDocId();
    if (leftId && leftId === id) syncLeftAvgCostFromLocation();
  } catch (e) {
    console.error('[data-entry] saveEditorLocationCosts error:', e);
    costsMsg.textContent = e?.message || 'Save failed.';
  }
}

/* ---------------- Live listener for saved location costs ---------------- */
function attachCostsListener(uid) {
  if (costsUnsub) { costsUnsub(); costsUnsub = null; }
  if (!uid) return;

  costsUnsub = onSnapshot(
    userServiceCostsByCountyCol(uid),
    (snap) => {
      const next = {};
      snap.forEach((d) => {
        const x = d.data() || {};
        next[d.id] = {
          state: x.state || '',
          county: x.county || '',
          case_mgmt: typeof x.case_mgmt === 'number' ? x.case_mgmt : 0,
          hdm: typeof x.hdm === 'number' ? x.hdm : 0,
          caregiver_respite: typeof x.caregiver_respite === 'number' ? x.caregiver_respite : 0,
          crisis_intervention: typeof x.crisis_intervention === 'number' ? x.crisis_intervention : 0,
          createdAt: x.createdAt,
          updatedAt: x.updatedAt,
        };
      });
      locationCosts = next;

      // Keep editor inputs in sync if we're looking at one of the updated docs
      fillEditorInputsFromCache();

      // Update saved list + mirror left avg cost
      renderSavedList();
      syncLeftAvgCostFromLocation();
    },
    (err) => {
      console.error('[data-entry] costs onSnapshot error:', err);
      costsMsg.textContent = 'Failed to load saved locations.';
    }
  );
}

/* ---------------- Recent Entries (server-side sorted listener) ---------------- */
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

/* ---------------- Events: left form changes ---------------- */
stateSel?.addEventListener('change', () => {
  populateCounties(stateSel.value);
  countySel.selectedIndex = 0;
  syncLeftAvgCostFromLocation();
});
countySel?.addEventListener('change', () => {
  syncLeftAvgCostFromLocation();
});
serviceSel?.addEventListener('change', () => {
  syncLeftAvgCostFromLocation();
});

/* ---------------- Events: right editor & navigator ---------------- */
costStateSel?.addEventListener('change', () => {
  setEditorLocation(costStateSel.value, null);
});
costCountySel?.addEventListener('change', () => {
  editorCounty = costCountySel.value || null;
  fillEditorInputsFromCache();
});
costUseCurrentBtn?.addEventListener('click', () => {
  if (!stateSel.value || !countySel.value) {
    costsMsg.textContent = 'Select a state and county in Add Tally first.';
    setTimeout(() => { if (costsMsg.textContent) costsMsg.textContent = ''; }, 2000);
    return;
  }
  setEditorLocation(stateSel.value, countySel.value);
});
costSaveBtn?.addEventListener('click', saveEditorLocationCosts);
costFilter?.addEventListener('input', renderSavedList);

savedListEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('.saved-item');
  if (!btn) return;
  const st = btn.getAttribute('data-state');
  const ct = btn.getAttribute('data-county');
  setEditorLocation(st, ct);

  // Also move left panel to the same location for quick tally entry
  if (stateCountyMap[st]) {
    stateSel.value = st;
    populateCounties(st);
    if (stateCountyMap[st].includes(ct)) countySel.value = ct;
    syncLeftAvgCostFromLocation();
  }
});

/* ---------------- Auth flow ---------------- */
onAuthStateChanged(auth, async (user) => {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  if (costsUnsub) { costsUnsub(); costsUnsub = null; }

  if (!user) {
    currentUid = null;
    await loadStates(); // still load states for layout

    // Reset caches and UI
    locationCosts = {};
    renderSavedList();

    // Left mirror shows 0 when not signed in
    avgCostInput.value = '0';

    tbody.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }

  currentUid = user.uid;
  await loadStates();         // populate selects
  attachCostsListener(currentUid); // live saved locations
  applyPrefsIfValid();        // may set service; mirror runs again inside
  attachListenerForUser(currentUid);

  // Initialize editor location to left selection if present; else default to first state
  if (stateSel.value && countySel.value) {
    setEditorLocation(stateSel.value, countySel.value);
  } else {
    const states = Object.keys(stateCountyMap);
    if (states.length) setEditorLocation(states[0], (stateCountyMap[states[0]] || [])[0] || null);
  }
});

/* ---------------- Submit / Add Doc ---------------- */
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUid) { msg.textContent = 'Please sign in.'; return; }

  const entry = {
    userId: currentUid,
    date: dateInput.value,
    state: stateSel.value,
    county: countySel.value,
    service: serviceSel.value,
    avgCostYear: clampNonNegInt(avgCostInput.value), // mirrored from location cost
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

/* ---------------- Row deletion (event delegation) ---------------- */
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

/* ---------------- Boot ---------------- */
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
