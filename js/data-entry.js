// /js/data-entry.js
// Firestore-backed Data Entry (per-user) WITH PAGINATION

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

// Right sidebar (per-location cost editor)
const costStateSel = $('#costState');
const costCountySel = $('#costCounty');
const costResetBtn = $('#costResetBtn');

const locCostsForm = $('#locCostsForm');
const loc_case_mgmt = $('#loc_cost_case_mgmt');
const loc_hdm = $('#loc_cost_hdm');
const loc_caregiver_respite = $('#loc_cost_caregiver_respite');
const loc_crisis_intervention = $('#loc_cost_crisis_intervention');
const costSaveBtn = $('#costSaveBtn');
const costsMsg = $('#costsMsg');

// Saved locations list
const savedList = $('#savedList');
const savedCount = $('#savedCount');
const costFilter = $('#costFilter');

// Table
const tbody = document.querySelector('#entriesTable tbody');
const emptyState = $('#emptyState');

// Pagination elements
const paginationControls = $('#paginationControls');
const prevPageBtn = $('#prevPageBtn');
const nextPageBtn = $('#nextPageBtn');
const currentPageSpan = $('#currentPage');
const totalPagesSpan = $('#totalPages');
const entryCountSpan = $('#entryCount');

// Pagination state
let currentPage = 1;
const ENTRIES_PER_PAGE = 25;
let totalEntries = 0;
let allEntries = [];

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
function userLocationCostsCol(uid) {
  // NOTE: Path matches rules at /users/{uid}/serviceCostsByCounty/{locId}
  return collection(db, 'users', uid, 'serviceCostsByCounty');
}
function locDocId(stateName, countyName) {
  const slugCounty = String(countyName).trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${String(stateName).toUpperCase()}__${slugCounty}`;
}
function userLocationCostsDoc(uid, stateName, countyName) {
  return doc(userLocationCostsCol(uid), locDocId(stateName, countyName));
}

// ---------- Service labels ----------
const SERVICE_LABELS = {
  case_mgmt: 'Case Management',
  hdm: 'Home-Delivered Meals',
  caregiver_respite: 'Caregiver/Respite',
  crisis_intervention: 'Crisis Intervention',
};
const serviceLabel = (code) => SERVICE_LABELS[code] ?? code ?? '';

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

    // Left selector
    stateSel.innerHTML =
      `<option value="" disabled ${states.length !== 1 ? 'selected' : ''}>Select a state</option>` +
      states.map((s) => `<option value="${s}">${s}</option>`).join('');

    // Right selector
    if (costStateSel) {
      costStateSel.innerHTML =
        `<option value="" disabled ${states.length !== 1 ? 'selected' : ''}>Select a state</option>` +
        states.map((s) => `<option value="${s}">${s}</option>`).join('');
    }

    // Defaults / prefs on left first
    const applied = applyPrefsIfValid();
    if (!applied) {
      if (states.length === 1) {
        defaultState = states[0];
        stateSel.value = defaultState;
        populateCounties(stateSel.value);
      } else {
        stateSel.selectedIndex = 0;
        countySel.innerHTML = `<option value="">Select a state first</option>`;
        countySel.disabled = true;
      }
    }

    // Initialize right panel to match left (so it's populated on refresh)
    const initRightState = stateSel.value || defaultState || states[0] || '';
    if (costStateSel) {
      costStateSel.value = initRightState || '';
      populateCostCounties(initRightState);

      // If left already has a county, mirror it; otherwise pick first county
      if (costCountySel) {
        if (countySel?.value && (stateCountyMap[initRightState] || []).includes(countySel.value)) {
          costCountySel.value = countySel.value;
        } else if (!costCountySel.value) {
          costCountySel.selectedIndex = 0;
        }
      }
    }

    statesLoaded = true;
  } catch (e) {
    console.error('[data-entry] loadStates error:', e);
    stateSel.innerHTML = `<option value="" disabled selected>Unable to load states</option>`;
    countySel.innerHTML = `<option value="">—</option>`;
    countySel.disabled = true;

    if (costStateSel) costStateSel.innerHTML = `<option value="" disabled selected>Unable to load states</option>`;
    if (costCountySel) {
      costCountySel.innerHTML = `<option value="">—</option>`;
      costCountySel.disabled = true;
    }
  }
}

function populateCounties(stateName) {
  const counties = stateCountyMap[stateName] || [];
  if (!counties.length) {
    countySel.innerHTML = `<option value="">No counties found for ${stateName || '—'}</option>`;
    countySel.disabled = true;
  } else {
    countySel.innerHTML = counties.map((c) => `<option value="${c}">${c}</option>`).join('');
    countySel.disabled = false;
  }
}

function populateCostCounties(stateName) {
  if (!costCountySel) return;
  const counties = stateCountyMap[stateName] || [];
  if (!counties.length) {
    costCountySel.innerHTML = `<option value="">Select a state first</option>`;
    costCountySel.disabled = true;
  } else {
    costCountySel.innerHTML = counties.map((c) => `<option value="${c}">${c}</option>`).join('');
    countCountySel.disabled = false;
  }
}

// Left selectors
stateSel?.addEventListener('change', async () => {
  populateCounties(stateSel.value);
  countySel.selectedIndex = 0;

  // Keep right panel aligned to left state
  if (costStateSel) {
    costStateSel.value = stateSel.value || '';
    populateCostCounties(costStateSel.value);
    costCountySel.selectedIndex = 0;
    await loadLocationCostsToForm();
    updateSavedActiveHighlight();
  }

  updateAvgCostMirror();
});

countySel?.addEventListener('change', async () => {
  // When left county changes, mirror to right and load costs
  if (costStateSel && costCountySel) {
    costStateSel.value = stateSel.value || '';
    populateCostCounties(costStateSel.value);
    costCountySel.value = countySel.value || '';
    await loadLocationCostsToForm();
    updateSavedActiveHighlight();
  }
  updateAvgCostMirror();
});

serviceSel?.addEventListener('change', () => updateAvgCostMirror());

// Right selectors
costStateSel?.addEventListener('change', async () => {
  populateCostCounties(costStateSel.value);
  // If left county matches the new state & has value, keep it aligned
  if (countySel?.value && (stateCountyMap[costStateSel.value] || []).includes(countySel.value)) {
    costCountySel.value = countySel.value;
  } else {
    costCountySel.selectedIndex = 0;
  }
  await loadLocationCostsToForm();
  updateAvgCostMirror();
  updateSavedActiveHighlight();
});

costCountySel?.addEventListener('change', async () => {
  await loadLocationCostsToForm();
  updateAvgCostMirror();
  updateSavedActiveHighlight();
});

// ---------- Per-location costs (right panel & mirror to left) ----------
let currentUid = null;

// cache: { [docId]: {state, county, case_mgmt, ...} }
const locCache = Object.create(null);

function clampNonNegInt(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

function getSelectedServiceKey() {
  // service codes match keys used in the doc
  return serviceSel?.value || 'case_mgmt';
}

// Mirror the saved cost for currently selected left state/county/service
async function updateAvgCostMirror() {
  if (!avgCostInput) return;
  const st = stateSel?.value;
  const co = countySel?.value;
  if (!currentUid || !st || !co) {
    avgCostInput.value = '0';
    return;
  }

  const id = locDocId(st, co);
  if (!locCache[id]) {
    try {
      const snap = await getDoc(userLocationCostsDoc(currentUid, st, co));
      locCache[id] = snap.exists() ? (snap.data() || {}) : {};
    } catch (e) {
      console.warn('[data-entry] updateAvgCostMirror load error:', e);
      locCache[id] = {};
    }
  }
  const key = getSelectedServiceKey();
  const num = clampNonNegInt(locCache[id]?.[key]);
  avgCostInput.value = String(num || 0);
}

function renderLocFormFrom(data) {
  if (!data) {
    if (loc_case_mgmt) loc_case_mgmt.value = '0';
    if (loc_hdm) loc_hdm.value = '0';
    if (loc_caregiver_respite) loc_caregiver_respite.value = '0';
    if (loc_crisis_intervention) loc_crisis_intervention.value = '0';
    return;
  }
  if (loc_case_mgmt) loc_case_mgmt.value = String(clampNonNegInt(data.case_mgmt ?? 0));
  if (loc_hdm) loc_hdm.value = String(clampNonNegInt(data.hdm ?? 0));
  if (loc_caregiver_respite) loc_caregiver_respite.value = String(clampNonNegInt(data.caregiver_respite ?? 0));
  if (loc_crisis_intervention) loc_crisis_intervention.value = String(clampNonNegInt(data.crisis_intervention ?? 0));
}

async function loadLocationCostsToForm() {
  if (!currentUid || !costStateSel?.value || !costCountySel?.value) {
    renderLocFormFrom(null);
    return;
  }
  const id = locDocId(costStateSel.value, costCountySel.value);
  if (!locCache[id]) {
    try {
      const snap = await getDoc(userLocationCostsDoc(currentUid, costStateSel.value, costCountySel.value));
      locCache[id] = snap.exists() ? (snap.data() || {}) : {};
    } catch (e) {
      console.warn('[data-entry] loadLocationCostsToForm error:', e);
      locCache[id] = {};
    }
  }
  renderLocFormFrom(locCache[id]);
}

async function saveLocationCosts() {
  if (!currentUid) { if (costsMsg) costsMsg.textContent = 'Please sign in.'; return; }
  if (!costStateSel?.value || !costCountySel?.value) { if (costsMsg) costsMsg.textContent = 'Select a state & county.'; return; }

  const payload = {
    state: costStateSel.value,
    county: costCountySel.value,
    case_mgmt: clampNonNegInt(loc_case_mgmt?.value),
    hdm: clampNonNegInt(loc_hdm?.value),
    caregiver_respite: clampNonNegInt(loc_caregiver_respite?.value),
    crisis_intervention: clampNonNegInt(loc_crisis_intervention?.value),
    updatedAt: serverTimestamp(),
  };
  const ref = userLocationCostsDoc(currentUid, payload.state, payload.county);

  try {
    await setDoc(ref, payload, { merge: true });
    const id = locDocId(payload.state, payload.county);
    locCache[id] = { ...locCache[id], ...payload };
    if (costsMsg) {
      costsMsg.textContent = 'Saved.';
      setTimeout(() => { if (costsMsg.textContent === 'Saved.') costsMsg.textContent = ''; }, 1500);
    }
    // If left matches right, immediately refresh mirror
    if (stateSel.value === payload.state && countySel.value === payload.county) {
      updateAvgCostMirror();
    }
    // Refresh saved locations list + highlight
    await refreshSavedLocations();
    updateSavedActiveHighlight();
  } catch (e) {
    console.error('[data-entry] saveLocationCosts error:', e);
    if (costsMsg) costsMsg.textContent = e?.message || 'Save failed.';
  }
}

// Save button
costSaveBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  saveLocationCosts();
});

// Zero-clear + Enter-to-save on right-side inputs
function wireRightInputs() {
  const inputs = Array.from(document.querySelectorAll('#locCostsForm input[type="number"]'));
  inputs.forEach((inp) => {
    // Clear "0" on focus
    inp.addEventListener('focus', () => {
      if (inp.value === '0') inp.value = '';
    });
    // Restore to "0" if left blank; otherwise clamp/normalize
    inp.addEventListener('blur', () => {
      const v = String(inp.value || '').trim();
      if (v === '') inp.value = '0';
      else inp.value = String(clampNonNegInt(v));
    });
    // Enter saves
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        saveLocationCosts();
      }
    });
  });
}
wireRightInputs();

// Reset all four costs to 0 and save
costResetBtn?.addEventListener('click', async () => {
  if (!costStateSel?.value || !costCountySel?.value) {
    if (costsMsg) costsMsg.textContent = 'Select a state & county.';
    return;
  }
  if (loc_case_mgmt) loc_case_mgmt.value = '0';
  if (loc_hdm) loc_hdm.value = '0';
  if (loc_caregiver_respite) loc_caregiver_respite.value = '0';
  if (loc_crisis_intervention) loc_crisis_intervention.value = '0';
  await saveLocationCosts();
});

// ---------- Prefs (remember last state/county/service) ----------
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
  // Also align right panel with left selection
  if (costStateSel && costCountySel) {
    costStateSel.value = stateSel.value || '';
    populateCostCounties(costStateSel.value);
    if (countySel.value) costCountySel.value = countySel.value;
  }

  updateAvgCostMirror();
  return true;
}

// ---------- Recent Entries (server-side sorted listener) WITH PAGINATION ----------
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
  // Store all entries
  allEntries = [];
  snapshot.forEach((docSnap) => {
    const e = docSnap.data() || {};
    allEntries.push({
      id: docSnap.id,
      ...e
    });
  });

  totalEntries = allEntries.length;
  renderCurrentPage();
}

function renderCurrentPage() {
  const totalPages = Math.ceil(totalEntries / ENTRIES_PER_PAGE);
  const startIndex = (currentPage - 1) * ENTRIES_PER_PAGE;
  const endIndex = startIndex + ENTRIES_PER_PAGE;
  const pageEntries = allEntries.slice(startIndex, endIndex);

  // Render rows for current page
  const rows = pageEntries.map(e => {
    let added = '';
    if (e.createdAt && typeof e.createdAt.toDate === 'function') {
      try { added = e.createdAt.toDate().toLocaleString(); } catch {}
    } else if (e.createdAtMs) {
      try { added = new Date(e.createdAtMs).toLocaleString(); } catch {}
    }

    return `
      <tr data-id="${e.id}">
        <td>${e.date ?? ''}</td>
        <td>${e.state ?? ''}</td>
        <td>${e.county ?? ''}</td>
        <td>${serviceLabel(e.service)}</td>
        <td>${formatCurrency(e.avgCostYear)}</td>
        <td>${e.yes ?? 0}</td>
        <td>${e.no ?? 0}</td>
        <td>${added}</td>
        <td style="text-align:right"><button class="de-btn de-btn-secondary de-btn-sm" data-del>Delete</button></td>
      </tr>
    `;
  }).join('');

  tbody.innerHTML = rows;
  emptyState.style.display = totalEntries === 0 ? 'block' : 'none';

  // Update pagination controls
  if (paginationControls) {
    if (totalPages > 1) {
      paginationControls.style.display = 'flex';
      if (currentPageSpan) currentPageSpan.textContent = currentPage;
      if (totalPagesSpan) totalPagesSpan.textContent = totalPages;
      if (entryCountSpan) entryCountSpan.textContent = totalEntries;
      
      if (prevPageBtn) prevPageBtn.disabled = currentPage === 1;
      if (nextPageBtn) nextPageBtn.disabled = currentPage === totalPages;
    } else {
      paginationControls.style.display = 'none';
    }
  }
}

function attachListenerForUser(uid) {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }

  // Fetch ALL entries (removed limit)
  const qRef = query(
    userTalliesCol(uid),
    orderBy('createdAt', 'desc')
  );

  unsubscribe = onSnapshot(
    qRef,
    (snap) => {
      currentPage = 1; // Reset to page 1 on new data
      renderRows(snap);
    },
    (err) => {
      console.error('[data-entry] onSnapshot error:', err);
      if (msg) msg.textContent = err?.message || 'Failed to load recent entries.';
    }
  );
}

// Pagination controls
prevPageBtn?.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    renderCurrentPage();
    // Scroll to top of table
    document.querySelector('#entriesTable')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

nextPageBtn?.addEventListener('click', () => {
  const totalPages = Math.ceil(totalEntries / ENTRIES_PER_PAGE);
  if (currentPage < totalPages) {
    currentPage++;
    renderCurrentPage();
    // Scroll to top of table
    document.querySelector('#entriesTable')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

// ---------- Saved locations list ----------
function pillForDoc(d) {
  const anySet = ['case_mgmt','hdm','caregiver_respite','crisis_intervention'].some(k => typeof d[k] === 'number' && d[k] >= 0);
  return anySet ? 'per-year set' : 'no values';
}

function isCurrentRightSelection(st, co) {
  return (costStateSel?.value === st) && (costCountySel?.value === co);
}

function updateSavedActiveHighlight() {
  if (!savedList) return;
  const children = savedList.querySelectorAll('.de-saved-item');
  children.forEach(el => {
    const st = el.getAttribute('data-state');
    const co = el.getAttribute('data-county');
    if (isCurrentRightSelection(st, co)) el.classList.add('active');
    else el.classList.remove('active');
  });
}

async function refreshSavedLocations() {
  if (!currentUid || !savedList) return;
  try {
    const snap = await getDocs(query(userLocationCostsCol(currentUid), orderBy('state'), limit(500)));
    const items = [];
    snap.forEach(docSnap => {
      const d = docSnap.data() || {};
      items.push({ id: docSnap.id, state: d.state, county: d.county, data: d });
      if (!locCache[docSnap.id]) locCache[docSnap.id] = d; // cache for mirror perf
    });

    const filter = (costFilter?.value || '').toLowerCase();
    const filtered = items.filter(x =>
      !filter ||
      String(x.county || '').toLowerCase().includes(filter) ||
      String(x.state || '').toLowerCase().includes(filter)
    ).sort((a,b) => (a.state || '').localeCompare(b.state || '') || (a.county || '').localeCompare(b.county || ''));

    savedList.innerHTML = filtered.map(x => `
      <div class="de-saved-item ${isCurrentRightSelection(x.state, x.county) ? 'active' : ''}" data-state="${x.state}" data-county="${x.county}" role="button" tabindex="0">
        <div>
          <div class="de-saved-name">${x.county || ''}</div>
          <div class="de-saved-sub">${x.state || ''}</div>
        </div>
        <div class="de-saved-right">
          <span class="de-pill">${pillForDoc(x.data)}</span>
          <button class="de-icon-btn" data-del aria-label="Delete saved location" title="Delete">&times;</button>
        </div>
      </div>
    `).join('');

    if (savedCount) savedCount.textContent = `${items.length}`;
  } catch (e) {
    console.warn('[data-entry] refreshSavedLocations error:', e);
  }
}

savedList?.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    // Delete the location; stop click-through
    e.stopPropagation();
    const container = del.closest('.de-saved-item');
    const st = container?.getAttribute('data-state');
    const co = container?.getAttribute('data-county');
    if (!st || !co || !currentUid) return;
    const ok = confirm(`Are you sure you want to delete ${co}, ${st} from your saved locations?`);
    if (!ok) return;
    try {
      await deleteDoc(userLocationCostsDoc(currentUid, st, co));
      const id = locDocId(st, co);
      delete locCache[id];
      await refreshSavedLocations();

      // If we just deleted the currently selected right location, clear fields and mirror
      if (isCurrentRightSelection(st, co)) {
        renderLocFormFrom(null);
        updateAvgCostMirror();
      }
    } catch (err) {
      console.error('[data-entry] delete location error:', err);
      alert(err?.message || 'Delete failed.');
    }
    return;
  }

  const btn = e.target.closest('.de-saved-item');
  if (!btn) return;
  const st = btn.getAttribute('data-state');
  const co = btn.getAttribute('data-county');
  if (!st || !co) return;

  // Jump the right panel to that location
  costStateSel.value = st;
  populateCostCounties(st);
  costCountySel.value = co;
  await loadLocationCostsToForm();

  // Set left location too so tally mirrors costs
  stateSel.value = st;
  populateCounties(st);
  countySel.value = co;
  updateAvgCostMirror();

  updateSavedActiveHighlight();
});

savedList?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    const item = e.target.closest('.de-saved-item');
    if (item) item.click();
  }
});

costFilter?.addEventListener('input', () => refreshSavedLocations());

// ---------- Auth flow ----------
onAuthStateChanged(auth, async (user) => {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }

  if (!user) {
    currentUid = null;
    await loadStates();      // still load states for layout
    // clear right side
    renderLocFormFrom(null);
    if (savedList) savedList.innerHTML = '';
    if (savedCount) savedCount.textContent = '';
    tbody.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }

  currentUid = user.uid;
  await loadStates();                // populate both left & right selects
  await loadLocationCostsToForm();   // populate right cost fields for its selected location
  applyPrefsIfValid();               // may set left state/county/service
  updateAvgCostMirror();             // ensure left mirror is in sync
  await refreshSavedLocations();     // show saved locations
  updateSavedActiveHighlight();
  attachListenerForUser(currentUid);
});

// ---------- Submit / Add Doc ----------
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUid) { if (msg) msg.textContent = 'Please sign in.'; return; }

  const entry = {
    userId: currentUid,
    date: dateInput.value,
    state: stateSel.value,
    county: countySel.value,
    service: serviceSel.value,
    avgCostYear: clampNonNegInt(avgCostInput.value), // mirrored from location doc
    yes: Number(yesInput.value || 0),
    no: Number(noInput.value || 0),
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
  };

  if (!entry.state || !entry.county) {
    if (msg) msg.textContent = 'Please select a state and county.';
    return;
  }

  try {
    await addDoc(userTalliesCol(currentUid), entry);
    if (msg) msg.textContent = 'Saved.';

    // Remember last selection AFTER a successful save
    savePrefs(entry.state, entry.county, entry.service);

    // Keep state/county/service; reset fast-changing fields
    const d = new Date();
    dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    yesInput.value = '0';
    noInput.value = '0';
  } catch (err) {
    console.error('[data-entry] addDoc error:', err);
    if (msg) msg.textContent = err.message;
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