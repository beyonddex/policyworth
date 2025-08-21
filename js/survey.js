// /js/survey.js
// Per-user survey templates: users/{uid}/surveys/{surveyId}
// Each survey doc: { title, locked, createdAt, updatedAt, questions: [ { id, type, text, options? } ] }

import { auth, db } from '/js/auth.js';
import {
  collection, doc, addDoc, getDocs, updateDoc, deleteDoc, setDoc, getDoc,
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
let pendingSelectId = null;        // <- after create/duplicate, select this when it arrives
let state = { surveys: [], current: null };

const DEFAULT_SURVEY_TITLE = 'Default Intake';
const DEFAULT_LOCKED_YESNO_ID = 'core_yesno';

// simple in-flight guards to prevent double-fires
const inflight = {
  creating: false,
  duplicating: false,
  deleting: false,
  saving: false,
};

// ---- Display helpers (type labels, escaping) ----
const TYPE_LABELS = {
  yesno: 'Yes / No',
  short: 'Short Text',
  long:  'Long Text',
  number:'Number',
  date:  'Date',
  multi: 'Multiple Choice',
};
const typeLabel = t => TYPE_LABELS[t] || t || '';
const option = (value, label, current) =>
  `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`;
const escapeHtml = (s='') =>
  s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const escapeAttr = (s='') => escapeHtml(s);
const uid = () => Math.random().toString(36).slice(2,10);

// ---- Payload sanitization (fixes permissions error) ----
function sanitizeQuestions(qs) {
  return (qs || []).map(q => {
    const out = {
      id: String(q.id || uid()),
      type: String(q.type || 'short'),
      text: String(q.text || '')
    };
    if (out.type === 'multi') {
      out.options = (q.options || []).map(o => String(o).trim()).filter(Boolean);
    }
    return out;
  });
}

function ensureCoreYesNoFirst(questions, src) {
  // Ensure core question exists and is at index 0 if survey is locked
  const srcCore = (src.questions || []).find(q => q.id === DEFAULT_LOCKED_YESNO_ID);
  const core = { id: DEFAULT_LOCKED_YESNO_ID, type: 'yesno',
                 text: srcCore?.text || 'Did the client receive the service today?' };
  const rest = questions.filter(q => q.id !== DEFAULT_LOCKED_YESNO_ID);
  return [core, ...rest];
}

/** Build a safe payload that matches security rules exactly */
function buildSurveyWritePayload(src, { forUpdate = false } = {}) {
  const locked = !!src.locked;
  let questions = sanitizeQuestions(src.questions);

  if (locked) {
    questions = ensureCoreYesNoFirst(questions, src);
  }

  const payload = {
    title: String(src.title || 'Untitled survey'),
    locked,
    questions,
    updatedAt: serverTimestamp(),
  };

  if (forUpdate) {
    if (src.createdAt) payload.createdAt = src.createdAt; // preserve createdAt on update
  } else {
    payload.createdAt = serverTimestamp();
  }

  return payload; // NOTE: no `id` field here
}

function userSurveysCol(uid) {
  return collection(db, 'users', uid, 'surveys');
}

function setBuilderMessage(txt) {
  els.builderMsg.textContent = txt || '';
  if (txt) setTimeout(() => { if (els.builderMsg.textContent === txt) els.builderMsg.textContent = ''; }, 2500);
}

// ---- Default survey: FIXED DOC ID to avoid duplicates ----
async function ensureDefaultSurvey() {
  const defRef = doc(db, 'users', currentUid, 'surveys', 'default');
  const defSnap = await getDoc(defRef);
  if (defSnap.exists()) return { id: defRef.id, ...defSnap.data() };

  const payload = {
    title: DEFAULT_SURVEY_TITLE,
    locked: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    questions: [
      { id: DEFAULT_LOCKED_YESNO_ID, type: 'yesno', text: 'Did the client receive the service today?' }
    ]
  };
  await setDoc(defRef, payload, { merge: false });
  return { id: defRef.id, ...payload };
}

function selectSurveyById(id) {
  const found = state.surveys.find(s => s.id === id);
  if (!found) return;
  // Preserve Firestore Timestamps (no JSON stringify) to keep createdAt valid in rules
  state.current = {
    id: found.id,
    title: found.title,
    locked: found.locked,
    createdAt: found.createdAt,
    updatedAt: found.updatedAt,
    questions: (found.questions || []).map(q => ({ ...q }))
  };
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
            ${option('yesno', typeLabel('yesno'), q.type)}
            ${option('short', typeLabel('short'), q.type)}
            ${option('long',  typeLabel('long'),  q.type)}
            ${option('number',typeLabel('number'),q.type)}
            ${option('date',  typeLabel('date'),  q.type)}
            ${option('multi', typeLabel('multi'), q.type)}
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
      renderBuilder();
    });
    if (multi) multi.addEventListener('input', () => {
      q.options = multi.value.split(',').map(s => s.trim()).filter(Boolean);
    });
    if (delBtn) delBtn.addEventListener('click', () => {
      if (state.current.locked && q.id === DEFAULT_LOCKED_YESNO_ID) return;
      state.current.questions = state.current.questions.filter(x => x.id !== id);
      renderBuilder();
    });
  });
}

/* ──────────────────────────────────────────────────────────────
   Add question (button + Enter-to-add)
   ────────────────────────────────────────────────────────────── */
function addQuestionFromInputs() {
  if (!state.current) return;
  const text = (els.newQText.value || '').trim();
  if (!text) { setBuilderMessage('Enter a question text.'); els.newQText.focus(); return; }

  const type = els.newQType.value;
  const q = { id: uid(), type, text };
  if (type === 'multi') q.options = [];

  state.current.questions = state.current.questions || [];
  state.current.questions.push(q);

  els.newQText.value = '';
  renderBuilder();
  els.newQText.focus();
  queueMicrotask(() => els.questionsList?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'end' }));
}

els.addQuestionBtn.addEventListener('click', addQuestionFromInputs);
els.newQText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
    e.preventDefault();
    addQuestionFromInputs();
  }
});
els.newQType.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    addQuestionFromInputs();
  }
});

/* ──────────────────────────────────────────────────────────────
   Save (CREATE/UPDATE with sanitized payload)
   ────────────────────────────────────────────────────────────── */
els.saveSurveyBtn.addEventListener('click', async () => {
  if (inflight.saving) return;
  if (!state.current) return;
  inflight.saving = true;
  els.saveSurveyBtn.disabled = true;

  const s = state.current;
  s.title = els.surveyTitleInput.value.trim() || 'Untitled survey';

  try {
    if (currentSurveyId) {
      const payload = buildSurveyWritePayload(s, { forUpdate: true });
      await updateDoc(doc(db, 'users', currentUid, 'surveys', currentSurveyId), payload);
    } else {
      const payload = buildSurveyWritePayload(s, { forUpdate: false });
      const d = await addDoc(userSurveysCol(currentUid), payload);
      currentSurveyId = d.id;
      pendingSelectId = d.id; // select when it shows up from snapshot
    }
    setBuilderMessage('Saved.');
  } catch (e) {
    console.error(e);
    setBuilderMessage('Save failed: ' + (e.message || e));
  } finally {
    inflight.saving = false;
    els.saveSurveyBtn.disabled = false;
  }
});

/* ──────────────────────────────────────────────────────────────
   New / duplicate / delete (no optimistic local mutation)
   ────────────────────────────────────────────────────────────── */
els.newTemplateBtn.addEventListener('click', async () => {
  if (inflight.creating) return;
  if (!currentUid) return;
  inflight.creating = true;
  els.newTemplateBtn.disabled = true;

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
    pendingSelectId = d.id;
    setBuilderMessage('Template created.');
  } catch (e) {
    console.error(e);
    setBuilderMessage('Create failed.');
  } finally {
    inflight.creating = false;
    els.newTemplateBtn.disabled = false;
  }
});

els.duplicateTemplateBtn.addEventListener('click', async () => {
  if (inflight.duplicating) return;
  if (!currentUid || !state.current) return;
  inflight.duplicating = true;
  els.duplicateTemplateBtn.disabled = true;

  const src = state.current;
  try {
    const clone = {
      title: `${src.title} (Copy)`,
      locked: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      questions: (src.questions || []).map(q => ({ ...q, id: q.id === DEFAULT_LOCKED_YESNO_ID ? DEFAULT_LOCKED_YESNO_ID : uid() }))
    };
    const d = await addDoc(userSurveysCol(currentUid), clone);
    currentSurveyId = d.id;
    pendingSelectId = d.id;
    setBuilderMessage('Template duplicated.');
  } catch (e) {
    console.error(e);
    setBuilderMessage('Duplicate failed.');
  } finally {
    inflight.duplicating = false;
    els.duplicateTemplateBtn.disabled = false;
  }
});

els.deleteTemplateBtn.addEventListener('click', async () => {
  if (inflight.deleting) return;
  if (!currentUid || !state.current) return;
  const s = state.current;
  if (s.locked) { setBuilderMessage('Locked template cannot be deleted.'); return; }
  if (!confirm(`Delete "${s.title}"? This cannot be undone.`)) return;

  inflight.deleting = true;
  els.deleteTemplateBtn.disabled = true;

  try {
    await deleteDoc(doc(db, 'users', currentUid, 'surveys', currentSurveyId));
    // Let onSnapshot update the list and selection
    currentSurveyId = null;
    state.current = null;
    setBuilderMessage('Deleted.');
  } catch (e) {
    console.error(e);
    setBuilderMessage('Delete failed.');
  } finally {
    inflight.deleting = false;
    els.deleteTemplateBtn.disabled = false;
  }
});

// ---- Print Preview (clean labels + Yes / No with slash) ----
els.downloadPdfBtn.addEventListener('click', () => exportCurrentSurveyToPdf());
els.printBtn.addEventListener('click', () => { buildPrintPreview(); window.print(); });

function buildPrintPreview() {
  const s = state.current;
  if (!s) return;
  els.printBody.innerHTML = `
    <h2 style="margin:0 0 8px 0;">${escapeHtml(s.title || 'Survey')}</h2>
    <div class="muted" style="margin-bottom:12px">Generated by PolicyWorth</div>
    <ol style="padding-left:18px">
      ${(s.questions || []).map(q => `<li style="margin-bottom:14px">
        <div><strong>${escapeHtml(q.text || '')}</strong> <span class="muted">(${escapeHtml(typeLabel(q.type))})</span></div>
        ${renderAnswerLineHTML(q)}
      </li>`).join('')}
    </ol>
  `;
}

function renderAnswerLineHTML(q) {
  switch (q.type) {
    case 'yesno': return `<div>☐ Yes / ☐ No</div>`;
    case 'short': return `<div style="border-bottom:1px solid #ddd; height:20px; width:60%"></div>`;
    case 'long':  return `<div style="border:1px solid #ddd; height:100px; width:100%"></div>`;
    case 'number':return `<div>__________</div>`;
    case 'date':  return `<div>____ / ____ / ______</div>`;
    case 'multi': return `<div>${(q.options||[]).map(o => `☐ ${escapeHtml(o)}`).join('<br>')}</div>`;
    default:      return `<div>__________</div>`;
  }
}

// ---- PDF Export (fillable with pdf-lib) ----
async function exportCurrentSurveyToPdf() {
  const s = state.current;
  if (!s) return;

  try {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;

    // Create doc & page constants (US Letter)
    const pdfDoc = await PDFDocument.create();
    const pageSize = { width: 612, height: 792 }; // 8.5" x 11" in points
    let page = pdfDoc.addPage([pageSize.width, pageSize.height]);
    const form = pdfDoc.getForm();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Layout constants
    const margin = 48;
    const contentW = pageSize.width - margin * 2;
    const lineH = 16;
    const qGap = 10;       // space between question label and field(s)
    const blockGap = 14;   // space after each question block
    const labelSize = 12;
    const titleSize = 18;
    const metaSize  = 10;
    const fieldH = 18;

    // Cursor (top-down)
    let y = pageSize.height - margin;

    const addPage = () => {
      addFooter();
      page = pdfDoc.addPage([pageSize.width, pageSize.height]);
      y = pageSize.height - margin;
    };

    const ensure = (h = lineH) => {
      if (y - h < margin) addPage();
    };

    const drawText = (text, x, size = labelSize, bold = false) => {
      page.drawText(String(text || ''), { x, y, size, font: bold ? fontBold : font, color: rgb(0,0,0) });
    };

    const addFooter = () => { /* page numbers drawn after all pages */ };

    // Header: Title
    drawText(s.title || 'Survey', margin, titleSize, true);
    y -= titleSize + 6;
    drawText('Generated by PolicyWorth', margin, metaSize, false);
    y -= metaSize + 10;

    // Respondent Name / Date fields (fillable)
    ensure(fieldH + 8);
    drawText('Name:', margin, 11, false);
    const nameField = form.createTextField('respondent_name');
    nameField.setText('');
    nameField.addToPage(page, { x: margin + 42, y: y - (fieldH - 4), width: 260, height: fieldH });

    drawText('Date:', margin + 320, 11, false);
    const dateField = form.createTextField('respondent_date');
    dateField.addToPage(page, { x: margin + 360, y: y - (fieldH - 4), width: 120, height: fieldH });
    y -= fieldH + 12;

    function addRadioGroup(fieldName, options) {
      const group = form.createRadioGroup(fieldName);
      let maxH = 0;
      let x = margin;
      options.forEach(opt => {
        ensure(fieldH);
        group.addOptionToPage(opt, page, { x, y: y - (fieldH - 10), width: 12, height: 12 });
        page.drawText(opt, { x: x + 18, y: y - 2, size: labelSize, font });
        const textW = font.widthOfTextAtSize(opt, labelSize);
        x += 18 + textW + 24;
        maxH = Math.max(maxH, fieldH);
      });
      y -= maxH + blockGap;
      return group;
    }

    const questions = (s.questions || []).map(q => ({
      ...q,
      type: q.type || 'short',
      text: q.text || ''
    }));

    questions.forEach((q, idx) => {
      const label = `${idx + 1}. ${q.text} (${typeLabel(q.type)})`;
      const wrapped = breakText(label, fontBold, labelSize, contentW);

      wrapped.forEach(line => {
        ensure(lineH);
        page.drawText(line, { x: margin, y, size: labelSize, font: fontBold });
        y -= lineH;
      });
      y -= qGap;

      const fieldBaseName = `q_${idx}_${(q.id || 'x')}`;

      switch (q.type) {
        case 'yesno': {
          addRadioGroup(fieldBaseName, ['Yes', 'No']);
          break;
        }
        case 'short': {
          ensure(fieldH);
          const tf = form.createTextField(`${fieldBaseName}_short`);
          tf.addToPage(page, { x: margin, y: y - (fieldH - 4), width: Math.min(340, contentW), height: fieldH });
          y -= fieldH + blockGap;
          break;
        }
        case 'long': {
          const height = 90;
          ensure(height);
          const tf = form.createTextField(`${fieldBaseName}_long`);
          tf.enableMultiline();
          tf.addToPage(page, { x: margin, y: y - height + 4, width: contentW, height });
          y -= height + blockGap;
          break;
        }
        case 'number': {
          ensure(fieldH);
          const tf = form.createTextField(`${fieldBaseName}_number`);
          tf.addToPage(page, { x: margin, y: y - (fieldH - 4), width: 160, height: fieldH });
          y -= fieldH + blockGap;
          break;
        }
        case 'date': {
          ensure(fieldH);
          const tf = form.createTextField(`${fieldBaseName}_date`);
          tf.addToPage(page, { x: margin, y: y - (fieldH - 4), width: 180, height: fieldH });
          page.drawText('MM / DD / YYYY', { x: margin + 8, y: y + 2, size: 9, font, color: rgb(0.5,0.5,0.5) });
          y -= fieldH + blockGap;
          break;
        }
        case 'multi': {
          const opts = (q.options || []).map(o => String(o).trim()).filter(Boolean);
          if (!opts.length) {
            ensure(fieldH);
            const tf = form.createTextField(`${fieldBaseName}_free`);
            tf.addToPage(page, { x: margin, y: y - (fieldH - 4), width: contentW, height: fieldH });
            y -= fieldH + blockGap;
          } else {
            const group = form.createRadioGroup(`${fieldBaseName}_radio`);
            let x = margin;
            opts.forEach(opt => {
              ensure(fieldH);
              group.addOptionToPage(opt, page, { x, y: y - (fieldH - 10), width: 12, height: 12 });
              page.drawText(opt, { x: x + 18, y: y - 2, size: labelSize, font });
              const textW = font.widthOfTextAtSize(opt, labelSize);
              if (x + 18 + textW + 24 > margin + contentW - 100) {
                y -= fieldH;
                x = margin;
              } else {
                x += 18 + textW + 24;
              }
            });
            y -= fieldH + blockGap;
          }
          break;
        }
        default: {
          ensure(fieldH);
          const tf = form.createTextField(`${fieldBaseName}_text`);
          tf.addToPage(page, { x: margin, y: y - (fieldH - 4), width: 220, height: fieldH });
          y -= fieldH + blockGap;
        }
      }
    });

    form.updateFieldAppearances(font);

    const total = pdfDoc.getPageCount();
    for (let i = 0; i < total; i++) {
      const p = pdfDoc.getPage(i);
      p.drawText(`Page ${i + 1} of ${total}`, {
        x: pageSize.width - margin,
        y: 16,
        size: 9,
        font,
        color: rgb(0,0,0),
      });
    }

    const bytes = await pdfDoc.save();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filename = (s.title || 'survey').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
    a.href = url; a.download = `${filename}.pdf`;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    a.remove();

  } catch (e) {
    console.error(e);
    setBuilderMessage('PDF export failed.');
  }

  function breakText(text, fontObj, size, maxWidth) {
    const words = String(text || '').split(/\s+/);
    const lines = [];
    let line = '';
    words.forEach(w => {
      const probe = line ? `${line} ${w}` : w;
      const width = fontObj.widthOfTextAtSize(probe, size);
      if (width > maxWidth && line) {
        lines.push(line);
        line = w;
      } else {
        line = probe;
      }
    });
    if (line) lines.push(line);
    return lines;
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

      // Auto-select logic
      if (pendingSelectId) {
        const found = state.surveys.find(s => s.id === pendingSelectId);
        if (found) { selectSurveyById(found.id); pendingSelectId = null; return; }
      }
      if (!currentSurveyId) {
        const def = state.surveys.find(s => s.locked && s.title === DEFAULT_SURVEY_TITLE) || state.surveys[0];
        if (def) selectSurveyById(def.id);
      } else {
        const still = state.surveys.find(s => s.id === currentSurveyId);
        if (!still && state.surveys[0]) selectSurveyById(state.surveys[0].id);
        // else keep current selection
      }
    },
    (err) => console.error('Template listener error:', err)
  );
}

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  currentUid = user.uid;
  await ensureDefaultSurvey();
  listenToTemplates();
});
