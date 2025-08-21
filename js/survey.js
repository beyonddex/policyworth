// /js/survey.js
// Per-user survey templates: users/{uid}/surveys/{surveyId}
// Each survey doc: { title, locked, createdAt, updatedAt, questions: [ { id, type, text, options? } ] }

import { auth, db } from '/js/auth.js';
import {
  collection, doc, addDoc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, query, orderBy, limit
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const els = {
  templateList: document.getElementById('templateList'),
  newTemplateBtn: document.getElementById('newTemplateBtn'),
  duplicateTemplateBtn: document.getElementById('duplicateTemplateBtn'),
  deleteTemplateBtn: document.getElementById('deleteTemplateBtn'),

  surveyTitleInput: document.getElementById('surveyTitleInput'),
  lockBadge: document.getElementById('lockBadge'),
  questionsList: document.getElementById('questionsList'),

  newQType: document.getElementById('newQType'),
  newQText: document.getElementById('newQText'),
  addQuestionBtn: document.getElementById('addQuestionBtn'),

  saveSurveyBtn: document.getElementById('saveSurveyBtn'),
  downloadPdfBtn: document.getElementById('downloadPdfBtn'),
  printBtn: document.getElementById('printBtn'),

  builderMsg: document.getElementById('builderMsg'),
  printPreview: document.getElementById('printPreview'),
  printBody: document.getElementById('printBody'),
};

let currentUid = null;
let unsubscribeTemplates = null;
let currentSurveyId = null;
let state = {
  surveys: [], // array of {id, ...docData}
  current: null, // {id, title, locked, questions:[]}
};

const DEFAULT_SURVEY_TITLE = 'Default Intake';
const DEFAULT_LOCKED_YESNO_ID = 'core_yesno';

// Ensure the per-user default locked survey exists
async function ensureDefaultSurvey() {
  const qRef = collection(db, 'users', currentUid, 'surveys');

  // Find an existing default
  const snap = await getDocs(qRef);
  let defaultDoc = null;
  snap.forEach(d => {
    const data = d.data();
    if (data.locked && data.title === DEFAULT_SURVEY_TITLE) {
      defaultDoc = { id: d.id, ...data };
    }
  });

  if (defaultDoc) return defaultDoc;

  // Create one
  const payload = {
    title: DEFAULT_SURVEY_TITLE,
    locked: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    questions: [
      { id: DEFAULT_LOCKED_YESNO_ID, type: 'yesno', text: 'Did the client receive the service today?' }
    ]
  };
  const created = await addDoc(qRef, payload);
  return { id: created.id, ...payload };
}

function userSurveysCol(uid) {
  return collection(db, 'users', uid, 'surveys');
}

function setBuilderMessage(txt) {
  els.builderMsg.textContent = txt || '';
  if (txt) setTimeout(() => { if (els.builderMsg.textContent === txt) els.builderMsg.textContent = ''; }, 2500);
}

function selectSurveyById(id) {
  const found = state.surveys.find(s => s.id === id);
  if (!found) return;
  state.current = JSON.parse(JSON.stringify(found));
  currentSurveyId = found.id;
  renderBuilder();
  highlightSelectedTemplate();
}

function highlightSelectedTemplate() {
  [...els.templateList.querySelectorAll('.list-item')].forEach(li => {
    li.classList.toggle('is-selected', li.dataset.id === currentSurveyId);
    li.style.outline = li.dataset.id === currentSurveyId ? '2px solid #d1d5db' : 'none';
  });
}

function renderTemplateList() {
  els.templateList.innerHTML = state.surveys.map(s => {
    const lockedBadge = s.locked ? ' 🔒' : '';
    const sub = s.locked ? 'Locked' : 'Custom';
    return `
      <div class="list-item" data-id="${s.id}">
        <div class="meta">
          <div class="title">${escapeHtml(s.title)}${lockedBadge}</div>
          <div class="sub">${sub} • ${s.questions?.length ?? 0} question(s)</div>
        </div>
        <div class="actions">
          <button class="btn" data-open>Open</button>
        </div>
      </div>
    `;
  }).join('');

  els.templateList.querySelectorAll('[data-open]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.target.closest('.list-item').dataset.id;
      selectSurveyById(id);
    });
  });
  highlightSelectedTemplate();
}

function renderBuilder() {
  const s = state.current;
  if (!s) return;

  els.surveyTitleInput.value = s.title || '';
  els.lockBadge.style.display = s.locked ? 'inline' : 'none';

  els.questionsList.innerHTML = (s.questions || []).map((q, idx) => {
    const lockedCore = s.locked && q.id === DEFAULT_LOCKED_YESNO_ID;
    const rowCls = lockedCore ? 'q-row locked' : 'q-row';
    return `
      <div class="${rowCls}" data-id="${q.id}">
        <div class="q-idx">#${idx + 1}</div>
        <div class="q-text">
          <input type="text" value="${escapeAttr(q.text || '')}" ${lockedCore ? 'disabled' : ''} placeholder="Question text…" />
        </div>
        <div class="q-type">
          <select ${lockedCore ? 'disabled' : ''}>
            ${option('yesno','Yes / No', q.type)}
            ${option('short','Short Text', q.type)}
            ${option('long','Long Text', q.type)}
            ${option('number','Number', q.type)}
            ${option('date','Date', q.type)}
            ${option('multi','Multiple Choice', q.type)}
          </select>
        </div>
        <div class="q-actions">
          ${lockedCore ? '<span class="muted" title="This core question cannot be removed.">—</span>' : '<button class="btn" data-del>✕</button>'}
        </div>

        ${q.type === 'multi' ? `
          <div class="span-6" style="grid-column: 2 / -1;">
            <input type="text" class="multi-input" placeholder="Choices (comma-separated)" value="${escapeAttr((q.options||[]).join(', '))}">
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  // Wire interactions
  [...els.questionsList.querySelectorAll('.q-row')].forEach(row => {
    const id = row.dataset.id;
    const q = (state.current.questions || []).find(x => x.id === id);
    const input = row.querySelector('.q-text input');
    const select = row.querySelector('.q-type select');
    const delBtn = row.querySelector('[data-del]');
    const multi = row.querySelector('.multi-input');

    if (input) input.addEventListener('input', () => { q.text = input.value; });
    if (select) select.addEventListener('change', () => {
      q.type = select.value;
      // Re-render to show/hide multi choices
      renderBuilder();
    });
    if (multi) multi.addEventListener('input', () => {
      q.options = multi.value.split(',').map(s => s.trim()).filter(Boolean);
    });
    if (delBtn) delBtn.addEventListener('click', () => {
      // Prevent removing the locked yes/no if somehow exposed
      if (state.current.locked && q.id === DEFAULT_LOCKED_YESNO_ID) return;
      state.current.questions = state.current.questions.filter(x => x.id !== id);
      renderBuilder();
    });
  });
}

function option(value, label, current) {
  return `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`;
}

function escapeHtml(s='') {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s='') { return escapeHtml(s); }
function uid() { return Math.random().toString(36).slice(2,10); }

// Events: toolbar
els.addQuestionBtn.addEventListener('click', () => {
  if (!state.current) return;
  if (!els.newQText.value.trim()) { setBuilderMessage('Enter a question text.'); return; }

  const q = {
    id: uid(),
    type: els.newQType.value,
    text: els.newQText.value.trim()
  };
  if (q.type === 'multi') q.options = [];

  state.current.questions = state.current.questions || [];
  state.current.questions.push(q);
  els.newQText.value = '';
  renderBuilder();
});

els.saveSurveyBtn.addEventListener('click', async () => {
  if (!state.current) return;
  const s = state.current;
  s.title = els.surveyTitleInput.value.trim() || 'Untitled survey';
  s.updatedAt = serverTimestamp();

  // Enforce presence of locked core question on locked surveys
  if (s.locked) {
    const hasCore = (s.questions || []).some(q => q.id === DEFAULT_LOCKED_YESNO_ID);
    if (!hasCore) {
      s.questions = [{ id: DEFAULT_LOCKED_YESNO_ID, type: 'yesno', text: 'Did the client receive the service today?' }].concat(s.questions || []);
    }
  }

  try {
    if (currentSurveyId) {
      await updateDoc(doc(db, 'users', currentUid, 'surveys', currentSurveyId), s);
    } else {
      const d = await addDoc(userSurveysCol(currentUid), { ...s, createdAt: serverTimestamp() });
      currentSurveyId = d.id;
    }
    setBuilderMessage('Saved.');
  } catch (e) {
    console.error(e);
    setBuilderMessage('Save failed: ' + (e.message || e));
  }
});

els.newTemplateBtn.addEventListener('click', async () => {
  if (!currentUid) return;
  try {
    const payload = {
      title: 'New Survey',
      locked: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      questions: []
    };
    const d = await addDoc(userSurveysCol(currentUid), payload);
    currentSurveyId = d.id;
    // local optimistic add
    state.surveys.push({ id: d.id, ...payload });
    selectSurveyById(d.id);
  } catch (e) {
    console.error(e);
  }
});

els.duplicateTemplateBtn.addEventListener('click', async () => {
  if (!currentUid || !state.current) return;
  const src = state.current;
  try {
    const clone = {
      title: `${src.title} (Copy)`,
      locked: false, // copies are editable unless you want to preserve lock
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      questions: (src.questions || []).map(q => ({ ...q, id: q.id === DEFAULT_LOCKED_YESNO_ID ? DEFAULT_LOCKED_YESNO_ID : uid() }))
    };
    const d = await addDoc(userSurveysCol(currentUid), clone);
    currentSurveyId = d.id;
    state.surveys.push({ id: d.id, ...clone });
    selectSurveyById(d.id);
  } catch (e) {
    console.error(e);
  }
});

els.deleteTemplateBtn.addEventListener('click', async () => {
  if (!currentUid || !state.current) return;
  const s = state.current;
  if (s.locked) { setBuilderMessage('Locked template cannot be deleted.'); return; }
  if (!confirm(`Delete "${s.title}"? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, 'users', currentUid, 'surveys', currentSurveyId));
    // remove locally
    state.surveys = state.surveys.filter(x => x.id !== currentSurveyId);
    currentSurveyId = null;
    state.current = null;
    renderTemplateList();
    renderBuilder();
    setBuilderMessage('Deleted.');
  } catch (e) {
    console.error(e);
    setBuilderMessage('Delete failed.');
  }
});

// PDF & Print
els.downloadPdfBtn.addEventListener('click', () => exportCurrentSurveyToPdf());
els.printBtn.addEventListener('click', () => {
  buildPrintPreview();
  window.print();
});

function buildPrintPreview() {
  const s = state.current;
  if (!s) return;
  els.printBody.innerHTML = `
    <h2 style="margin:0 0 8px 0;">${escapeHtml(s.title || 'Survey')}</h2>
    <div class="muted" style="margin-bottom:12px">Generated by PolicyWorth</div>
    <ol style="padding-left:18px">
      ${(s.questions || []).map(q => `<li style="margin-bottom:14px">
        <div><strong>${escapeHtml(q.text || '')}</strong> <span class="muted">(${q.type})</span></div>
        ${renderAnswerLine(q)}
      </li>`).join('')}
    </ol>
  `;
}

function renderAnswerLine(q) {
  switch (q.type) {
    case 'yesno':
      return `<div>☐ Yes &nbsp;&nbsp; ☐ No</div>`;
    case 'short':
      return `<div style="border-bottom:1px solid #ddd; height:20px; width:60%"></div>`;
    case 'long':
      return `<div style="border:1px solid #ddd; height:100px; width:100%"></div>`;
    case 'number':
      return `<div>__________</div>`;
    case 'date':
      return `<div>____ / ____ / ______</div>`;
    case 'multi':
      return `<div>${(q.options||[]).map(o => `☐ ${escapeHtml(o)}`).join('&nbsp;&nbsp;')}</div>`;
    default:
      return `<div>__________</div>`;
  }
}

async function exportCurrentSurveyToPdf() {
  const s = state.current;
  if (!s) return;
  buildPrintPreview();
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 48;
    let y = margin;

    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(16);
    doc.text(s.title || 'Survey', margin, y); y += 16 + 6;

    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(10);
    doc.text('Generated by PolicyWorth', margin, y); y += 10 + 12;

    doc.setFontSize(12);

    (s.questions || []).forEach((q, idx) => {
      const qText = `${idx+1}. ${q.text || ''} (${q.type})`;
      const wrapped = doc.splitTextToSize(qText, pageWidth - margin*2);
      if (y + wrapped.length*14 > doc.internal.pageSize.getHeight() - margin) {
        doc.addPage(); y = margin;
      }
      doc.text(wrapped, margin, y); y += wrapped.length*14 + 8;

      // answer lines
      let ans = '';
      switch (q.type) {
        case 'yesno': ans = '☐ Yes     ☐ No'; break;
        case 'short': ans = '______________________________'; break;
        case 'long': ans = '\n\n\n'; break;
        case 'number': ans = '__________'; break;
        case 'date': ans = '____ / ____ / ______'; break;
        case 'multi': ans = (q.options||[]).map(o => `☐ ${o}`).join('   '); break;
        default: ans = '__________';
      }
      const aWrapped = doc.splitTextToSize(ans, pageWidth - margin*2);
      if (y + aWrapped.length*14 > doc.internal.pageSize.getHeight() - margin) {
        doc.addPage(); y = margin;
      }
      doc.text(aWrapped, margin, y); y += aWrapped.length*14 + 14;
    });

    doc.save(`${(s.title || 'survey').toLowerCase().replace(/\s+/g,'-')}.pdf`);
  } catch (e) {
    console.error(e);
    setBuilderMessage('PDF export failed.');
  }
}

// Live template listing
function listenToTemplates() {
  if (unsubscribeTemplates) { unsubscribeTemplates(); unsubscribeTemplates = null; }
  unsubscribeTemplates = onSnapshot(
    query(userSurveysCol(currentUid), orderBy('createdAt','desc'), limit(100)),
    (snap) => {
      state.surveys = [];
      snap.forEach(d => state.surveys.push({ id: d.id, ...d.data() }));
      renderTemplateList();

      // Choose a default selection
      if (!currentSurveyId) {
        // Prefer locked default
        const def = state.surveys.find(s => s.locked && s.title === DEFAULT_SURVEY_TITLE) || state.surveys[0];
        if (def) selectSurveyById(def.id);
      } else {
        // Keep selection if still present
        const still = state.surveys.find(s => s.id === currentSurveyId);
        if (!still && state.surveys[0]) selectSurveyById(state.surveys[0].id);
      }
    },
    (err) => console.error('Template listener error:', err)
  );
}

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  currentUid = user.uid;

  // Ensure default locked survey exists once per user
  await ensureDefaultSurvey();

  // Start live listing
  listenToTemplates();
});
