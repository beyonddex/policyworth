// /js/reports.js
import { auth, db } from '/js/auth.js';
import {
  collection, query, where, getDocs, doc, getDoc, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const $ = (s, r=document) => r.querySelector(s);

// Controls
const periodType = $('#periodType');
const qWrap = $('#qWrap');
const quarterSel = $('#quarter');
const yearSel = $('#year');
const fromWrap = $('#customFromWrap');
const toWrap = $('#customToWrap');
const dateFrom = $('#dateFrom');
const dateTo = $('#dateTo');

// Services are CHECKBOX CHIPS inside div#services
const servicesWrap = $('#services');

// Survey controls
const surveySel = $('#surveySel');
const surveyQuestionsWrap = $('#surveyQuestions');
const qHelp = $('#qHelp');

// Report action buttons
const runBtn = $('#runBtn');
const clearBtn = $('#clearBtn');

const printBtn = $('#printBtn');
const pngBtn = $('#pngBtn');
const csvBtn = $('#csvBtn');

// Report nodes
const rangeLabel = $('#rangeLabel');
const periodLabel = $('#periodLabel');
const clientsTotalEl = $('#clientsTotal');
const yesTotalEl = $('#yesTotal');
const noTotalEl = $('#noTotal');
const taxpayerSavingsEl = $('#taxpayerSavings');
const economicImpactEl = $('#economicImpact');
const fedEl = $('#federalTaxes');
const stateEl = $('#stateTaxes');
const localEl = $('#localTaxes');

const svc1SavedLabel = $('#svc1SavedLabel');
const svc2SavedLabel = $('#svc2SavedLabel');
const svc1Note = $('#svc1Note');
const svc2Note = $('#svc2Note');

const svcA = $('#svcA');
const svcB = $('#svcB');

const q1TitleEl = $('#q1Title');
const q2TitleEl = $('#q2Title');
const q3TitleEl = $('#q3Title');

const runNote = $('#runNote');

// ===== Settings from /config/app (no fallbacks)
let CONFIG = { params: {} };

function numParam(name) {
  const v = CONFIG?.params?.[name];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  return NaN;
}

async function loadConfig() {
  const snap = await getDoc(doc(db, 'config', 'app'));
  CONFIG = snap.exists() ? (snap.data() || { params: {} }) : { params: {} };
  if (!CONFIG.params) CONFIG.params = {};
}

// ================== STATE ==================
let currentUid = null;
let lastExport = null;
let htmlToImage = null;

// Survey state
const surveysCache = Object.create(null);
let selectedSurveyId = '';
let selectedQuestionIds = new Set(); // up to 2

// ================== HELPERS ==================
const pad = (n)=> String(n).padStart(2,'0');
const thisYear = ()=> (new Date()).getFullYear();
const thisQuarter = ()=>{
  const m = (new Date()).getMonth()+1;
  return m<=3?1:m<=6?2:m<=9?3:4;
};

function asDate(str) {
  const [y,m,d] = (str||'').split('-').map(Number);
  return new Date(y || 1970, (m||1)-1, d||1);
}
function daysDiffInclusive(aStr, bStr) {
  const a = asDate(aStr), b = asDate(bStr);
  const ms = (b - a) + (24*60*60*1000);
  return Math.max(1, Math.round(ms / (24*60*60*1000)));
}
function periodFraction(from, to) {
  return daysDiffInclusive(from, to) / 365;
}

function quarterRange(y, q){
  const startMonth = {1:1, 2:4, 3:7, 4:10}[q];
  const from = `${y}-${pad(startMonth)}-01`;
  const endDay = new Date(y, startMonth + 2, 0).getDate();
  const to = `${y}-${pad(startMonth + 2)}-${pad(endDay)}`;
  return { from, to };
}
const yearRange = (y)=> ({ from: `${y}-01-01`, to: `${y}-12-31` });
function ytdRange(){
  const now = new Date();
  return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}` };
}
function getSelectedServices(){
  return Array.from(servicesWrap.querySelectorAll('input[type="checkbox"]:checked')).map(i=>i.value);
}
function usd(n){
  if (!isFinite(n)) return '$—';
  return n.toLocaleString(undefined, { style:'currency', currency:'USD', maximumFractionDigits:0 });
}
function docIdForCounty(state, county){
  const slug = String(county).trim().replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  return `${String(state).toUpperCase()}__${slug}`;
}
function prettySvc(k){
  return ({
    case_mgmt: 'Case Management',
    hdm: 'Home-Delivered Meals',
    caregiver_respite: 'Caregiver Respite',
    crisis_intervention: 'Crisis Intervention',
  })[k] || k;
}
function questionTitle(q){
  return q?.label || q?.text || q?.title || q?.question || (q?.id || 'Question');
}
function currentPeriodLabel(){
  const y = Number(yearSel.value || thisYear());
  if (periodType.value === 'quarter') return `Q${quarterSel.value || thisQuarter()} ${y}`;
  if (periodType.value === 'year')    return `Annual ${y}`;
  if (periodType.value === 'ytd')     return `YTD ${thisYear()}`;
  return 'Custom';
}

// ================== UI WIRING ==================
(function fillYears(){
  const start = thisYear();
  const opts = [];
  for (let y = start; y >= 1980; y--) {
    const sel = y === start ? ' selected' : '';
    opts.push(`<option value="${y}"${sel}>${y}</option>`);
  }
  yearSel.innerHTML = opts.join('');
})();

(function initDefaults(){
  quarterSel.value = String(thisQuarter());
  periodType.value = 'quarter';
  qWrap.style.display = '';
  fromWrap.style.display = toWrap.style.display = 'none';
  updatePeriodLabels();
})();

function updateVisibleControls(){
  const t = periodType.value;
  qWrap.style.display = (t === 'quarter') ? '' : 'none';
  fromWrap.style.display = toWrap.style.display = (t === 'custom') ? '' : 'none';
  updatePeriodLabels();
}
periodType.addEventListener('change', updateVisibleControls);
quarterSel.addEventListener('change', updatePeriodLabels);
yearSel.addEventListener('change', updatePeriodLabels);
dateFrom.addEventListener('change', updatePeriodLabels);
dateTo.addEventListener('change', updatePeriodLabels);

function updatePeriodLabels(){
  const y = Number(yearSel.value || thisYear());
  let range;
  if (periodType.value === 'quarter') range = quarterRange(y, Number(quarterSel.value || thisQuarter()));
  else if (periodType.value === 'year') range = yearRange(y);
  else if (periodType.value === 'ytd') range = ytdRange();
  else range = { from: dateFrom.value || '—', to: dateTo.value || '—' };

  rangeLabel.textContent = `${range.from} → ${range.to}`;
  periodLabel.textContent = currentPeriodLabel();
}

// ----- Surveys
async function loadSurveys(){
  if (!currentUid || !surveySel) return;
  surveySel.innerHTML = `<option value="">(No survey)</option>`;
  try {
    const qRef = query(collection(db, 'users', currentUid, 'surveys'), orderBy('updatedAt', 'desc'));
    const snap = await getDocs(qRef);
    const opts = ['<option value="">(No survey)</option>'];
    snap.forEach(docSnap => {
      const d = docSnap.data() || {};
      surveysCache[docSnap.id] = d;
      opts.push(`<option value="${docSnap.id}">${d.title || '(Untitled Survey)'}</option>`);
    });
    surveySel.innerHTML = opts.join('');
  } catch (e) {
    console.warn('[reports] loadSurveys error:', e);
  }
  renderQuestionsForCurrentSurvey();
}

function renderQuestionsForCurrentSurvey(){
  surveyQuestionsWrap.innerHTML = '';
  selectedQuestionIds = new Set();
  qHelp.textContent = '';

  const id = surveySel?.value || '';
  selectedSurveyId = id;

  const fallbackQ1 = 'Remain at home due to our services?';
  let q1 = fallbackQ1;

  if (!id || !surveysCache[id]) {
    q1TitleEl.textContent = q1;
    q2TitleEl.textContent = 'Survey Question #2';
    q3TitleEl.textContent = 'Survey Question #3';
    q2TitleEl.style.opacity = '0.75';
    q3TitleEl.style.opacity = '0.75';
    return;
  }

  const survey = surveysCache[id];
  const qs = Array.isArray(survey.questions) ? survey.questions : [];

  const core = qs.find(q => q?.id === 'core_yesno') || qs[0];
  if (core) q1 = questionTitle(core) || q1;
  q1TitleEl.textContent = q1;

  const candidates = qs.filter(q => !q?.id || q.id !== 'core_yesno');
  if (!candidates.length) {
    qHelp.textContent = 'This survey has only the core question.';
    q2TitleEl.textContent = 'Survey Question #2';
    q3TitleEl.textContent = 'Survey Question #3';
    q2TitleEl.style.opacity = '0.75';
    q3TitleEl.style.opacity = '0.75';
    return;
  }

  surveyQuestionsWrap.innerHTML = candidates.map(q => {
    const label = questionTitle(q);
    const qid = q?.id || label.toLowerCase().replace(/\W+/g,'_');
    return `
      <label class="svc-chip">
        <input type="checkbox" value="${qid}">
        <span>${label}</span>
      </label>
    `;
  }).join('');

  const MAX = 2;
  const inputs = Array.from(surveyQuestionsWrap.querySelectorAll('input[type="checkbox"]'));

  function reflectTitles(){
    const chosen = inputs.filter(i => i.checked).slice(0, MAX);
    const labels = chosen.map(i => i.nextElementSibling?.textContent || '—');
    q2TitleEl.textContent = labels[0] || 'Survey Question #2';
    q3TitleEl.textContent = labels[1] || 'Survey Question #3';
    q2TitleEl.style.opacity = labels[0] ? '1' : '0.75';
    q3TitleEl.style.opacity = labels[1] ? '1' : '0.75';
    selectedQuestionIds = new Set(chosen.map(i => i.value));
    qHelp.textContent = chosen.length >= MAX ? `You’ve selected ${MAX}.` : '';
  }

  surveyQuestionsWrap.addEventListener('change', (e) => {
    const tgt = e.target;
    if (tgt?.type === 'checkbox') {
      const checkedCount = inputs.filter(i => i.checked).length;
      if (checkedCount > MAX) {
        tgt.checked = false;
      }
      reflectTitles();
    }
  });

  reflectTitles();
}

// ----- Clear
clearBtn.addEventListener('click', () => {
  periodType.value = 'quarter';
  quarterSel.value = String(thisQuarter());
  yearSel.value = String(thisYear());
  dateFrom.value = '';
  dateTo.value = '';

  servicesWrap.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  surveySel.value = '';
  renderQuestionsForCurrentSurvey();

  updateVisibleControls();

  clientsTotalEl.textContent = '—';
  yesTotalEl.textContent = '—';
  noTotalEl.textContent = '—';
  taxpayerSavingsEl.textContent = '$—';
  fedEl.textContent = '$—';
  stateEl.textContent = '$—';
  localEl.textContent = '$—';
  economicImpactEl.textContent = '$—';
  svc1SavedLabel.textContent = '$—';
  svc2SavedLabel.textContent = '$—';
  svc1Note.textContent = '—';
  svc2Note.textContent = '—';
  svcA.textContent = 'Case Management';
  svcB.textContent = 'Caregiver Respite';
  runNote.textContent = '';
  lastExport = null;
});

// ================== Core fetch + compute (settings-driven only) ==================
async function runReport(){
  if (!currentUid) return;

  const selectedSvcs = getSelectedServices();
  if (selectedSvcs.length === 0) {
    runNote.textContent = 'Select at least one service.';
    return;
  }

  // Resolve date range
  const y = Number(yearSel.value || thisYear());
  let range;
  if (periodType.value === 'quarter')      range = quarterRange(y, Number(quarterSel.value || thisQuarter()));
  else if (periodType.value === 'year')    range = yearRange(y);
  else if (periodType.value === 'ytd')     range = ytdRange();
  else {
    const f = dateFrom.value;
    const t = dateTo.value;
    if (!f || !t) { runNote.textContent = 'Pick both start and end dates for Custom.'; return; }
    if (f > t)    { runNote.textContent = '“From” must be before “To”.'; return; }
    range = { from: f, to: t };
  }

  const { from, to } = range;
  rangeLabel.textContent = `${from} → ${to}`;
  periodLabel.textContent = currentPeriodLabel();
  runNote.textContent = 'Running…';

  // ==== REQUIRE parameters from settings (no fallbacks) ====
  const REQUIRED = [
    'DEFAULT_NH_YEARLY',
    'TAXPAYER_MULTIPLIER',
    'TAX_RATE_FEDERAL',
    'TAX_RATE_STATE',
    'TAX_RATE_LOCAL',
    'ECONOMIC_MULTIPLIER',
    'SPLIT_STATE_SHARE',
    'SPLIT_FEDERAL_SHARE',
  ];
  const missing = REQUIRED.filter(k => isNaN(numParam(k)));
  if (missing.length) {
    runNote.textContent = `Missing/invalid settings: ${missing.join(', ')}. Open Settings → save required parameters.`;
    return;
  }

  const DEFAULT_NH_YEARLY   = numParam('DEFAULT_NH_YEARLY');
  const TAXPAYER_MULTIPLIER = numParam('TAXPAYER_MULTIPLIER');
  const TAX_RATE_FEDERAL    = numParam('TAX_RATE_FEDERAL');
  const TAX_RATE_STATE      = numParam('TAX_RATE_STATE');
  const TAX_RATE_LOCAL      = numParam('TAX_RATE_LOCAL');
  const ECONOMIC_MULTIPLIER = numParam('ECONOMIC_MULTIPLIER');
  const SPLIT_STATE_SHARE   = numParam('SPLIT_STATE_SHARE');
  const SPLIT_FEDERAL_SHARE = numParam('SPLIT_FEDERAL_SHARE');

  // sanity: splits should sum ~1
  const splitSum = SPLIT_STATE_SHARE + SPLIT_FEDERAL_SHARE;
  if (Math.abs(splitSum - 1) > 0.001) {
    runNote.textContent = `Warning: SPLIT_STATE_SHARE + SPLIT_FEDERAL_SHARE = ${splitSum.toFixed(3)} (expected 1.0).`;
    // continue anyway using provided values
  }

  const frac = periodFraction(from, to);

  // Pull tallies in range
  const services = new Set(selectedSvcs);
  const qRef = query(
    collection(db, 'users', currentUid, 'tallies'),
    where('date', '>=', from),
    where('date', '<=', to)
  );
  const snap = await getDocs(qRef);

  // Collect unique locations for county cost fetch
  const entries = [];
  const countyIds = new Set();
  snap.forEach(d => {
    const e = d.data() || {};
    if (!services.has(e.service)) return;
    if (!e.state || !e.county) return;
    entries.push(e);
    countyIds.add(docIdForCounty(e.state, e.county));
  });

  // Fetch county NH yearly for each unique id (batched)
  const countyMap = Object.create(null);
  await Promise.all(Array.from(countyIds).map(async id => {
    try {
      const s = await getDoc(doc(db, 'countyCosts', id));
      countyMap[id] = s.exists() ? (s.data() || {}) : {};
    } catch { countyMap[id] = {}; }
  }));

  // Compute aggregates (settings-driven)
  let yesTotal = 0;
  let noTotal = 0;
  let clientsTotal = 0;

  const perService = {
    case_mgmt: { yes:0, no:0, saved:0 },
    hdm: { yes:0, no:0, saved:0 },
    caregiver_respite: { yes:0, no:0, saved:0 },
    crisis_intervention: { yes:0, no:0, saved:0 },
  };

  for (const e of entries) {
    const id = docIdForCounty(e.state, e.county);
    const nhYearly = Number(countyMap[id]?.nhYearly);
    const nhUse = isFinite(nhYearly) ? nhYearly : DEFAULT_NH_YEARLY; // still a setting, not hard-coded
    const svcYearly = Number(e.avgCostYear) || 0;

    const yN = Number(e.yes) || 0;
    const nN = Number(e.no) || 0;

    yesTotal += yN;
    noTotal += nN;
    clientsTotal += (yN + nN);

    // yes * ((nhYearly - avgCostYear) * periodFraction) * TAXPAYER_MULTIPLIER
    const baseAvoided = (nhUse - svcYearly) * frac;
    const savedAdjusted = yN * baseAvoided * TAXPAYER_MULTIPLIER;

    if (perService[e.service]) {
      perService[e.service].yes += yN;
      perService[e.service].no  += nN;
      perService[e.service].saved += Math.max(0, savedAdjusted);
    }
  }

  const taxpayerSavings =
    perService.case_mgmt.saved +
    perService.hdm.saved +
    perService.caregiver_respite.saved +
    perService.crisis_intervention.saved;

  const taxes = {
    federal: taxpayerSavings * TAX_RATE_FEDERAL,
    state:   taxpayerSavings * TAX_RATE_STATE,
    local:   taxpayerSavings * TAX_RATE_LOCAL,
  };

  const economicImpact = taxpayerSavings * ECONOMIC_MULTIPLIER;

  const stateShare   = taxpayerSavings * SPLIT_STATE_SHARE;
  const federalShare = taxpayerSavings * SPLIT_FEDERAL_SHARE;

  // Bind to UI
  clientsTotalEl.textContent = clientsTotal.toLocaleString();
  yesTotalEl.textContent = yesTotal.toLocaleString();
  noTotalEl.textContent = noTotal.toLocaleString();

  taxpayerSavingsEl.textContent = usd(taxpayerSavings);
  fedEl.textContent = usd(taxes.federal);
  stateEl.textContent = usd(taxes.state);
  localEl.textContent = usd(taxes.local);
  economicImpactEl.textContent = usd(economicImpact);

  // Top two services by savings (respect selected services)
  const ranked = Object.entries(perService)
    .filter(([k]) => services.has(k))
    .sort((a,b)=>b[1].saved-a[1].saved);

  const [s1, s2] = ranked;
  if (s1) {
    svc1SavedLabel.textContent = `${usd(s1[1].saved)} Saved — ${prettySvc(s1[0])}`;
    svc1Note.textContent = `${(s1[1].yes).toLocaleString()} clients avoided higher-cost care after receiving ${prettySvc(s1[0])}.`;
  } else {
    svc1SavedLabel.textContent = '$—';
    svc1Note.textContent = '—';
  }
  if (s2) {
    svc2SavedLabel.textContent = `${usd(s2[1].saved)} Saved — ${prettySvc(s2[0])}`;
    svc2Note.textContent = `${(s2[1].yes).toLocaleString()} clients avoided higher-cost care after receiving ${prettySvc(s2[0])}.`;
  } else {
    svc2SavedLabel.textContent = '$—';
    svc2Note.textContent = '—';
  }

  const selectedPretty = getSelectedServices().map(prettySvc);
  svcA.textContent = (s1 ? prettySvc(s1[0]) : selectedPretty[0] || '—');
  svcB.textContent = (s2 ? prettySvc(s2[0]) : selectedPretty[1] || selectedPretty[0] || '—');

  runNote.textContent = `Report updated • ${entries.length.toLocaleString()} entries across ${countyIds.size} location(s).`;

  lastExport = {
    range,
    perService,
    taxpayerSavings,
    economicImpact,
    taxes,
    clientsTotal,
    yesTotal,
    noTotal,
    savingsSplit: { stateShare, federalShare },
    surveyContext: {
      surveyId: selectedSurveyId || '',
      q1Title: q1TitleEl?.textContent || '',
      q2Title: q2TitleEl?.textContent || '',
      q3Title: q3TitleEl?.textContent || ''
    }
  };
}

runBtn.addEventListener('click', runReport);

// Enter to run
document.querySelector('.controls')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    runReport();
  }
});

// ----- Export
printBtn.addEventListener('click', () => window.print());

pngBtn.addEventListener('click', async () => {
  if (!htmlToImage) {
    htmlToImage = await import('https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.esm.js');
  }
  const node = document.getElementById('reportCanvas');
  const dataUrl = await htmlToImage.toPng(node, { cacheBust:true, pixelRatio:2 });
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `policyworth-report.png`;
  a.click();
});

csvBtn.addEventListener('click', () => {
  if (!lastExport) return;
  const s = lastExport;

  const selected = new Set(getSelectedServices());
  const rows = [];
  rows.push(['Metric','Value']);
  rows.push(['From', s.range.from]);
  rows.push(['To', s.range.to]);
  rows.push(['Clients total', s.clientsTotal]);
  rows.push(['Yes', s.yesTotal]);
  rows.push(['No', s.noTotal]);
  rows.push(['Taxpayer savings (adjusted)', s.taxpayerSavings]);
  rows.push(['Economic impact', s.economicImpact]);
  rows.push(['Federal taxes', s.taxes.federal]);
  rows.push(['State taxes', s.taxes.state]);
  rows.push(['Local taxes', s.taxes.local]);
  rows.push(['State share of savings', s.savingsSplit.stateShare]);
  rows.push(['Federal share of savings', s.savingsSplit.federalShare]);
  rows.push([]);
  rows.push(['Survey','Value']);
  rows.push(['Survey ID', s.surveyContext.surveyId || '(none)']);
  rows.push(['Question 1', s.surveyContext.q1Title || '']);
  rows.push(['Question 2', s.surveyContext.q2Title || '']);
  rows.push(['Question 3', s.surveyContext.q3Title || '']);
  rows.push([]);
  rows.push(['Service','Yes','No','Saved']);
  for (const [k,v] of Object.entries(s.perService)) {
    if (!selected.has(k)) continue;
    rows.push([prettySvc(k), v.yes, v.no, v.saved]);
  }

  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'policyworth-report.csv';
  a.click();
});

// ----- Auth
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  currentUid = user.uid;
  await loadConfig();  // must load settings first
  await loadSurveys();
  // runReport(); // optional auto-run
});
