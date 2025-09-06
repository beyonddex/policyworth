// /js/settings.js
// Admin-only config UI.
//   /config/app: { params: {KEY:val}, equations:[{id,label,expr,notes?}], updatedAt }
//   /countyCosts/{STATE__County_Slug}: { state, county, nhDaily, source, effectiveYear, createdAt, updatedAt }

import { auth, db } from '/js/auth.js';
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
  collection, query, where, orderBy, getDocs, deleteDoc
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

/* ---------------- DOM ---------------- */
const els = {
  adminWrap: document.getElementById('adminWrap'),
  forbidden: document.getElementById('forbidden'),
  // params/equations
  paramsTbody: document.getElementById('paramsTbody'),
  addParamBtn: document.getElementById('addParamBtn'),
  eqList: document.getElementById('eqList'),
  addEqBtn: document.getElementById('addEqBtn'),
  saveBtn: document.getElementById('saveBtn'),
  revertBtn: document.getElementById('revertBtn'),
  msg: document.getElementById('msg'),
  // county costs (optional section)
  ccState: document.getElementById('ccState'),
  ccAddCountySel: document.getElementById('ccAddCountySel'),
  ccAddBtn: document.getElementById('ccAddBtn'),
  ccFilter: document.getElementById('ccFilter'),
  ccTbody: document.getElementById('ccTbody'),
  ccSaveBtn: document.getElementById('ccSaveBtn'),
  ccMsg: document.getElementById('ccMsg'),
};

const CONFIG_DOC = doc(db, 'config', 'app');
const STATES_URL = '/data/states-counties.json';

/* ---------------- State ---------------- */
let state = {
  admin: false,
  params: {},
  equations: [],
  original: null,

  // county costs
  statesMap: {},          // { Florida: ["Sarasota", ...], ... }
  ccRows: [],             // [{ id, state, county, nhDaily, source, effectiveYear, _dirty?, _new? }]
  ccActiveState: null,
  ccFilterText: '',
};

/* ---------------- Helpers ---------------- */
function setMsg(text) {
  if (els.msg) els.msg.textContent = text || '';
  if (text) setTimeout(() => { if (els.msg && els.msg.textContent === text) els.msg.textContent = ''; }, 2500);
}
function setCcMsg(text) {
  if (els.ccMsg) els.ccMsg.textContent = text || '';
  if (text) setTimeout(() => { if (els.ccMsg && els.ccMsg.textContent === text) els.ccMsg.textContent = ''; }, 2500);
}
function escapeHtml(s='') {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function sanitizeKey(k='') {
  return String(k).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+|_+$/g,'');
}
function isNumberLike(v) {
  if (typeof v === 'number') return true;
  if (typeof v !== 'string') return false;
  if (v.trim() === '') return false;
  return !isNaN(Number(v));
}
function slugCounty(county='') {
  return String(county).trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function countyDocId(st, county) {
  return `${String(st).toUpperCase()}__${slugCounty(county)}`;
}

/* ---------------- Admin check ---------------- */
async function isAdminUser(user) {
  if (!user) return false;
  try {
    const token = await user.getIdTokenResult();
    if (token?.claims?.admin === true) return true;
  } catch {}
  try {
    const snap = await getDoc(doc(db, 'admins', user.uid));
    return snap.exists();
  } catch {
    return false;
  }
}

/* ---------------- Params ---------------- */
function renderParams() {
  if (!els.paramsTbody) return;
  const entries = Object.entries(state.params);
  els.paramsTbody.innerHTML = entries.map(([key, val], idx) => {
    const type = (typeof val === 'number' || isNumberLike(val)) ? 'number' : 'text';
    const displayVal = type === 'number' ? String(val) : String(val ?? '');
    return `
      <tr data-row="${idx}">
        <td><input class="param-key" value="${escapeHtml(key)}" placeholder="RATE_HDM" /></td>
        <td>
          <select class="param-type">
            <option value="number" ${type==='number'?'selected':''}>Number</option>
            <option value="text" ${type!=='number'?'selected':''}>Text</option>
          </select>
        </td>
        <td><input class="param-value" value="${escapeHtml(displayVal)}" placeholder="e.g. 1.25" /></td>
        <td class="row-actions"><button class="btn danger" data-del>&times;</button></td>
      </tr>
    `;
  }).join('');

  [...els.paramsTbody.querySelectorAll('tr')].forEach((tr) => {
    const apply = () => {
      const rows = [...els.paramsTbody.querySelectorAll('tr')];
      const map = {};
      for (const row of rows) {
        const k = sanitizeKey(row.querySelector('.param-key').value);
        if (!k) continue;
        const t = row.querySelector('.param-type').value;
        const vRaw = row.querySelector('.param-value').value;
        map[k] = (t === 'number' && isNumberLike(vRaw)) ? Number(vRaw) : vRaw;
      }
      state.params = map;
    };
    tr.querySelector('.param-key').addEventListener('input', apply);
    tr.querySelector('.param-type').addEventListener('change', apply);
    tr.querySelector('.param-value').addEventListener('input', apply);
    tr.querySelector('[data-del]').addEventListener('click', () => { tr.remove(); apply(); });
  });
}

function addParamRow() {
  const base = 'NEW_PARAM';
  let k = base, n = 1;
  while (Object.prototype.hasOwnProperty.call(state.params, k)) k = `${base}_${n++}`;
  state.params = { ...state.params, [k]: '' };
  renderParams();
}

/* ---------------- Equations ---------------- */
function renderEquations() {
  if (!els.eqList) return;
  els.eqList.innerHTML = (state.equations || []).map((eq) => `
    <div class="card" data-eq="${eq.id}" style="margin:12px 0; padding:12px">
      <div class="form-grid">
        <label class="span-3">
          <span>Label</span>
          <input class="eq-label" value="${escapeHtml(eq.label || '')}" placeholder="e.g. HDM Impact" />
        </label>
        <label class="span-3">
          <span>Notes (optional)</span>
          <input class="eq-notes" value="${escapeHtml(eq.notes || '')}" placeholder="Shown in reports as helper text" />
        </label>
        <label class="span-6">
          <span>Expression</span>
          <textarea class="eq-expr" placeholder="(yes - no) * param('RATE_HDM')">${escapeHtml(eq.expr || '')}</textarea>
        </label>
      </div>
      <div class="row-actions" style="margin-top:8px">
        <span class="pill">id: ${escapeHtml(eq.id)}</span>
        <button class="btn danger" data-del>Remove</button>
      </div>
    </div>
  `).join('');

  [...els.eqList.querySelectorAll('[data-eq]')].forEach((wrap) => {
    const id = wrap.getAttribute('data-eq');
    const eq = state.equations.find(e => e.id === id);
    const lbl = wrap.querySelector('.eq-label');
    const expr = wrap.querySelector('.eq-expr');
    const notes = wrap.querySelector('.eq-notes');

    lbl.addEventListener('input', () => { eq.label = lbl.value; });
    expr.addEventListener('input', () => { eq.expr = expr.value; });
    notes.addEventListener('input', () => { eq.notes = notes.value; });

    wrap.querySelector('[data-del]').addEventListener('click', () => {
      state.equations = state.equations.filter(e => e.id !== id);
      renderEquations();
    });
  });
}

function addEquation() {
  const id = Math.random().toString(36).slice(2, 10);
  state.equations = state.equations.concat([{ id, label: '', expr: '', notes: '' }]);
  renderEquations();
}

/* ---------------- Load/Save config/app ---------------- */
async function loadConfig() {
  const snap = await getDoc(CONFIG_DOC);
  if (snap.exists()) {
    const data = snap.data() || {};
    state.params = data.params || {};
    state.equations = Array.isArray(data.equations) ? data.equations : [];
  } else {
    await setDoc(CONFIG_DOC, { params: {}, equations: [], updatedAt: serverTimestamp() }, { merge: true });
    state.params = {};
    state.equations = [];
  }
  state.original = JSON.parse(JSON.stringify({ params: state.params, equations: state.equations }));
  renderParams();
  renderEquations();
}

async function saveConfig() {
  const map = {};
  for (const [kRaw, v] of Object.entries(state.params || {})) {
    const k = sanitizeKey(kRaw);
    if (!k) continue;
    if (v === '' || v === null || typeof v === 'undefined') continue;
    map[k] = isNumberLike(v) ? Number(v) : v;
  }
  const eqs = (state.equations || []).map(e => ({
    id: String(e.id || Math.random().toString(36).slice(2,10)),
    label: String(e.label || ''),
    expr: String(e.expr || ''),
    ...(e.notes ? { notes: String(e.notes) } : {})
  }));

  try {
    await updateDoc(CONFIG_DOC, { params: map, equations: eqs, updatedAt: serverTimestamp() });
  } catch {
    await setDoc(CONFIG_DOC, { params: map, equations: eqs, updatedAt: serverTimestamp() }, { merge: true });
  }
  state.original = JSON.parse(JSON.stringify({ params: map, equations: eqs }));
  setMsg('Saved.');
}

function revertConfig() {
  if (!state.original) return;
  state.params = JSON.parse(JSON.stringify(state.original.params || {}));
  state.equations = JSON.parse(JSON.stringify(state.original.equations || []));
  renderParams();
  renderEquations();
  setMsg('Reverted.');
}

/* ---------------- County Costs ---------------- */
// Load states+counties from your JSON
async function loadStatesMap() {
  if (!els.ccState) return; // section not present, skip entirely
  const res = await fetch(STATES_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load states-counties.json');
  state.statesMap = await res.json();

  const states = Object.keys(state.statesMap).sort();
  els.ccState.innerHTML = states.map(s => `<option value="${s}">${s}</option>`).join('');

  // Prefer Florida if present, else first key
  const pref = states.includes('Florida') ? 'Florida' : states[0];
  await setActiveState(pref);
}

async function setActiveState(stateName) {
  state.ccActiveState = stateName;
  if (els.ccState) els.ccState.value = stateName;

  const counties = (state.statesMap[stateName] || []).slice().sort();
  if (els.ccAddCountySel) {
    els.ccAddCountySel.innerHTML = counties.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  }

  await loadCountyCostsForState(stateName);
  renderCountyCosts();
}

async function loadCountyCostsForState(stateName) {
  state.ccRows = [];
  const qRef = query(
    collection(db, 'countyCosts'),
    where('state', '==', stateName),
    orderBy('county')
  );
  const snap = await getDocs(qRef);
  snap.forEach(d => {
    const x = d.data() || {};
    state.ccRows.push({
      id: d.id,
      state: x.state,
      county: x.county,
      nhDaily: typeof x.nhDaily === 'number' ? x.nhDaily : null,
      source: x.source || '',
      effectiveYear: x.effectiveYear || '',
      _dirty: false,
      _new: false,
    });
  });
}

function addCountyRow() {
  const st = state.ccActiveState;
  const county = els.ccAddCountySel?.value;
  if (!st || !county) return;

  const exists = state.ccRows.some(r => r.county === county);
  if (exists) { setCcMsg('That county is already listed.'); return; }

  state.ccRows.push({
    id: countyDocId(st, county),
    state: st,
    county,
    nhDaily: null,
    source: '',
    effectiveYear: new Date().getFullYear(),
    _dirty: true,
    _new: true,
  });
  renderCountyCosts();
  setCcMsg('Row added.');
}

function renderCountyCosts() {
  if (!els.ccTbody) return;
  const filter = (state.ccFilterText || '').toLowerCase();
  const rows = state.ccRows
    .filter(r => !filter || r.county.toLowerCase().includes(filter))
    .sort((a,b) => a.county.localeCompare(b.county));

  els.ccTbody.innerHTML = rows.map(r => `
    <tr data-id="${r.id}" class="${r._dirty ? 'row-dirty' : ''}">
      <td style="padding:10px">${escapeHtml(r.county)}</td>
      <td style="padding:10px"><input type="number" step="0.01" min="0" value="${r.nhDaily ?? ''}" class="cc-nh" style="width:140px" /></td>
      <td style="padding:10px"><input type="text" value="${escapeHtml(r.source || '')}" class="cc-src" placeholder="Genworth 2024" /></td>
      <td style="padding:10px"><input type="number" step="1" min="1900" max="3000" value="${r.effectiveYear ?? ''}" class="cc-year" style="width:100px" /></td>
      <td style="padding:10px; text-align:right"><button class="btn danger" data-del>&times;</button></td>
    </tr>
  `).join('');

  [...els.ccTbody.querySelectorAll('tr')].forEach(tr => {
    const id = tr.getAttribute('data-id');
    const row = state.ccRows.find(r => r.id === id);
    const nh = tr.querySelector('.cc-nh');
    const src = tr.querySelector('.cc-src');
    const yr = tr.querySelector('.cc-year');
    const del = tr.querySelector('[data-del]');

    const mark = () => { row._dirty = true; tr.classList.add('row-dirty'); };

    nh.addEventListener('input', () => { row.nhDaily = nh.value === '' ? null : Number(nh.value); mark(); });
    src.addEventListener('input', () => { row.source = src.value; mark(); });
    yr.addEventListener('input', () => { row.effectiveYear = yr.value === '' ? '' : Number(yr.value); mark(); });

    del.addEventListener('click', async () => {
      if (!confirm(`Remove ${row.county}?`)) return;
      try { await deleteDoc(doc(db, 'countyCosts', id)); } catch {}
      state.ccRows = state.ccRows.filter(r => r.id !== id);
      renderCountyCosts();
      setCcMsg('Removed.');
    });
  });
}

async function saveCountyCosts() {
  const dirty = state.ccRows.filter(r => r._dirty);
  if (!dirty.length) { setCcMsg('Nothing to save.'); return; }

  let ok = 0, fail = 0;
  for (const r of dirty) {
    try {
      const payload = {
        state: r.state,
        county: r.county,
        nhDaily: typeof r.nhDaily === 'number' ? r.nhDaily : 0,
        source: r.source || '',
        effectiveYear: r.effectiveYear || null,
        updatedAt: serverTimestamp(),
        ...(r._new ? { createdAt: serverTimestamp() } : {}),
      };
      await setDoc(doc(db, 'countyCosts', r.id), payload, { merge: true });
      r._dirty = false; r._new = false; ok++;
    } catch (e) {
      console.error('Save county cost failed', r, e);
      fail++;
    }
  }
  renderCountyCosts();
  setCcMsg(`Saved ${ok} row(s)${fail ? `, ${fail} failed` : ''}.`);
}

/* ---------------- Wire events ---------------- */
// params/equations
els.addParamBtn?.addEventListener('click', addParamRow);
els.addEqBtn?.addEventListener('click', addEquation);
els.saveBtn?.addEventListener('click', saveConfig);
els.revertBtn?.addEventListener('click', revertConfig);

// county costs
els.ccState?.addEventListener('change', (e) => setActiveState(e.target.value));
els.ccAddBtn?.addEventListener('click', addCountyRow);
els.ccFilter?.addEventListener('input', (e) => { state.ccFilterText = e.target.value || ''; renderCountyCosts(); });
els.ccSaveBtn?.addEventListener('click', saveCountyCosts);

/* ---------------- Auth/Admin gate ---------------- */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    if (els.adminWrap) els.adminWrap.style.display = 'none';
    if (els.forbidden) els.forbidden.style.display = 'none';
    return;
  }
  const admin = await isAdminUser(user);
  state.admin = admin;

  if (!admin) {
    if (els.adminWrap) els.adminWrap.style.display = 'none';
    if (els.forbidden) els.forbidden.style.display = 'block';
    return;
  }

  if (els.forbidden) els.forbidden.style.display = 'none';
  if (els.adminWrap) els.adminWrap.style.display = 'block';

  try {
    await loadConfig();             // params + equations
    await loadStatesMap();          // only runs if county section exists
  } catch (e) {
    console.error(e);
    setMsg('Failed to load settings.');
  }
});
