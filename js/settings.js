// /js/settings.js
// Admin-only config UI. Stores a single doc at /config/app:
// { params: { KEY: value, ... }, equations: [ { id, label, expr, notes? } ], updatedAt }
// Firestore rules already restrict read/write to admins.

import { auth, db } from '/js/auth.js';
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDoc as getDocFS, doc as docFS } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ---- DOM
const els = {
  adminWrap: document.getElementById('adminWrap'),
  forbidden: document.getElementById('forbidden'),
  paramsTbody: document.getElementById('paramsTbody'),
  addParamBtn: document.getElementById('addParamBtn'),
  eqList: document.getElementById('eqList'),
  addEqBtn: document.getElementById('addEqBtn'),
  saveBtn: document.getElementById('saveBtn'),
  revertBtn: document.getElementById('revertBtn'),
  msg: document.getElementById('msg'),
};

// ---- Local state
let state = {
  params: {},          // map of key -> value (number|string)
  equations: [],       // [{id,label,expr,notes?}]
  original: null,      // snapshot for revert
  admin: false,
};

const CONFIG_DOC = doc(db, 'config', 'app');

// ---- Admin check (claim OR /admins/{uid} existence)
async function isAdminUser(user) {
  if (!user) return false;
  try {
    const token = await user.getIdTokenResult();
    if (token?.claims?.admin === true) return true;
  } catch {}
  try {
    const snap = await getDocFS(docFS(db, 'admins', user.uid));
    return snap.exists();
  } catch {
    return false;
  }
}

// ---- UI helpers
function setMsg(text) {
  els.msg.textContent = text || '';
  if (text) setTimeout(() => { if (els.msg.textContent === text) els.msg.textContent = ''; }, 2500);
}
function escapeHtml(s='') {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&gt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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

// ---- Render: Parameters
function renderParams() {
  const entries = Object.entries(state.params);
  els.paramsTbody.innerHTML = entries.map(([key, val], idx) => {
    const type = typeof val === 'number' || isNumberLike(val) ? 'number' : 'text';
    const displayVal = type === 'number' ? String(val) : String(val ?? '');
    return `
      <tr data-row="${idx}">
        <td>
          <input class="param-key" value="${escapeHtml(key)}" placeholder="RATE_HDM" />
        </td>
        <td>
          <select class="param-type">
            <option value="number" ${type==='number'?'selected':''}>Number</option>
            <option value="text" ${type!=='number'?'selected':''}>Text</option>
          </select>
        </td>
        <td>
          <input class="param-value" value="${escapeHtml(displayVal)}" placeholder="e.g. 1.25" />
        </td>
        <td class="row-actions">
          <button class="btn danger" data-del>&times;</button>
        </td>
      </tr>
    `;
  }).join('');

  // Wire up changes
  [...els.paramsTbody.querySelectorAll('tr')].forEach((tr, i) => {
    const keyEl = tr.querySelector('.param-key');
    const typeEl = tr.querySelector('.param-type');
    const valEl = tr.querySelector('.param-value');
    const del = tr.querySelector('[data-del]');

    const apply = () => {
      // rebuild params from rows
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

    keyEl.addEventListener('input', apply);
    typeEl.addEventListener('change', apply);
    valEl.addEventListener('input', apply);
    del.addEventListener('click', () => {
      tr.remove();
      apply();
    });
  });
}

// ---- Render: Equations
function renderEquations() {
  els.eqList.innerHTML = (state.equations || []).map((eq, i) => `
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
          <textarea class="eq-expr" placeholder="(yes - no) * params.RATE_HDM">${escapeHtml(eq.expr || '')}</textarea>
        </label>
      </div>
      <div class="row-actions" style="margin-top:8px">
        <span class="pill">id: ${escapeHtml(eq.id)}</span>
        <button class="btn danger" data-del>Remove</button>
      </div>
    </div>
  `).join('');

  // Wire changes
  [...els.eqList.querySelectorAll('[data-eq]')].forEach((wrap) => {
    const id = wrap.getAttribute('data-eq');
    const eq = state.equations.find(e => e.id === id);
    const lbl = wrap.querySelector('.eq-label');
    const expr = wrap.querySelector('.eq-expr');
    const notes = wrap.querySelector('.eq-notes');
    const del = wrap.querySelector('[data-del]');

    lbl.addEventListener('input', () => { eq.label = lbl.value; });
    expr.addEventListener('input', () => { eq.expr = expr.value; });
    notes.addEventListener('input', () => { eq.notes = notes.value; });

    del.addEventListener('click', () => {
      state.equations = state.equations.filter(e => e.id !== id);
      renderEquations();
    });
  });
}

function addParamRow() {
  // Add a blank param row with a unique suggested key
  const base = 'NEW_PARAM';
  let k = base; let n = 1;
  while (Object.prototype.hasOwnProperty.call(state.params, k)) { k = `${base}_${n++}`; }
  state.params = { ...state.params, [k]: '' };
  renderParams();
}

function addEquation() {
  const id = Math.random().toString(36).slice(2, 10);
  state.equations = state.equations.concat([{ id, label: '', expr: '', notes: '' }]);
  renderEquations();
}

// ---- Load/Save
async function loadConfig() {
  const snap = await getDoc(CONFIG_DOC);
  if (snap.exists()) {
    const data = snap.data() || {};
    state.params = data.params || {};
    state.equations = Array.isArray(data.equations) ? data.equations : [];
  } else {
    // Create an empty config so later reads succeed cleanly
    await setDoc(CONFIG_DOC, { params: {}, equations: [], updatedAt: serverTimestamp() }, { merge: true });
    state.params = {};
    state.equations = [];
  }
  state.original = JSON.parse(JSON.stringify({ params: state.params, equations: state.equations }));
  renderParams();
  renderEquations();
}

async function saveConfig() {
  // Build clean payload
  // 1) Params: sanitize keys; drop empties; coerce numbers
  const map = {};
  for (const [kRaw, v] of Object.entries(state.params || {})) {
    const k = sanitizeKey(kRaw);
    if (!k) continue;
    if (v === '' || v === null || typeof v === 'undefined') continue;
    map[k] = isNumberLike(v) ? Number(v) : v;
  }

  // 2) Equations: keep minimal fields
  const eqs = (state.equations || []).map(e => ({
    id: String(e.id || Math.random().toString(36).slice(2,10)),
    label: String(e.label || ''),
    expr: String(e.expr || ''),
    ...(e.notes ? { notes: String(e.notes) } : {})
  }));

  try {
    await updateDoc(CONFIG_DOC, {
      params: map,
      equations: eqs,
      updatedAt: serverTimestamp(),
    });
    state.original = JSON.parse(JSON.stringify({ params: map, equations: eqs }));
    setMsg('Saved.');
  } catch (e) {
    // If doc didn't exist yet, fall back to setDoc
    try {
      await setDoc(CONFIG_DOC, { params: map, equations: eqs, updatedAt: serverTimestamp() }, { merge: true });
      state.original = JSON.parse(JSON.stringify({ params: map, equations: eqs }));
      setMsg('Saved.');
    } catch (err) {
      console.error(err);
      setMsg('Save failed: ' + (err.message || err));
    }
  }
}

function revertConfig() {
  if (!state.original) return;
  state.params = JSON.parse(JSON.stringify(state.original.params || {}));
  state.equations = JSON.parse(JSON.stringify(state.original.equations || []));
  renderParams();
  renderEquations();
  setMsg('Reverted.');
}

// ---- Wire events
els.addParamBtn.addEventListener('click', addParamRow);
els.addEqBtn.addEventListener('click', addEquation);
els.saveBtn.addEventListener('click', saveConfig);
els.revertBtn.addEventListener('click', revertConfig);

// ---- Auth/Admin gate
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    // nav-auth will redirect; show nothing here
    els.adminWrap.style.display = 'none';
    els.forbidden.style.display = 'none';
    return;
  }
  const admin = await isAdminUser(user);
  state.admin = admin;

  if (!admin) {
    els.adminWrap.style.display = 'none';
    els.forbidden.style.display = 'block';
    return;
  }

  els.forbidden.style.display = 'none';
  els.adminWrap.style.display = 'block';
  try {
    await loadConfig();
  } catch (e) {
    console.error(e);
    setMsg('Failed to load settings.');
  }
});
