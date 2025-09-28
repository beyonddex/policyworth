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

// Services chips
const servicesWrap = $('#services');

// Survey controls
const surveySel = $('#surveySel');
const surveyQuestionsWrap = $('#surveyQuestions');
const qHelp = $('#qHelp');

// Action buttons
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
const taxpayerSavingsEl = $('#taxpayerSavings'); // BASE savings shown here
const economicImpactEl = $('#economicImpact');
const fedEl = $('#federalTaxes');
const stateEl = $('#stateTaxes');
const localEl = $('#localTaxes');
const multipliedSavingsEl = $('#multipliedSavings'); // adjusted/multiplied

// Top-two bubbles (existing)
const svc1SavedLabel = $('#svc1SavedLabel');
const svc2SavedLabel = $('#svc2SavedLabel');
const svc1Note = $('#svc1Note');
const svc2Note = $('#svc2Note');

// Summary sentence parts
const introEl = $('#intro');
const orgNameEl = $('#orgName');
const svcA = $('#svcA');
const svcB = $('#svcB');

const q1TitleEl = $('#q1Title');
const q2TitleEl = $('#q2Title');
const q3TitleEl = $('#q3Title');

const runNote = $('#runNote');

// ===== Settings =====
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

// Charts
let svcStackedBarChart = null;   // by service (base vs multiplier)
let impactCompositionPie = null; // total economic impact composition

// Survey state
const surveysCache = Object.create(null);
let selectedSurveyId = '';
let selectedQuestionIds = new Set(); // up to 2

// ================== HELPERS ==================
const pad = (n)=> String(n).padStart(2,'0');
const thisYear = ()=> (new Date()).getFullYear();
const thisQuarter = ()=>{ const m = (new Date()).getMonth()+1; return m<=3?1:m<=6?2:m<=9?3:4; };

function asDate(str) {
  const [y,m,d] = (str||'').split('-').map(Number);
  return new Date(y || 1970, (m||1)-1, d||1);
}
function daysDiffInclusive(aStr, bStr) {
  const a = asDate(aStr), b = asDate(bStr);
  const ms = (b - a) + (24*60*60*1000);
  return Math.max(1, Math.round(ms / (24*60*60*1000)));
}
function periodFraction(from, to) { return daysDiffInclusive(from, to) / 365; }

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
function compactUSD(n){
  if (!isFinite(n)) return '$—';
  return n.toLocaleString(undefined, { style:'currency', currency:'USD', notation:'compact', maximumFractionDigits:1 });
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
function questionTitle(q){ return q?.label || q?.text || q?.title || q?.question || (q?.id || 'Question'); }
function currentPeriodLabel(){
  const y = Number(yearSel.value || thisYear());
  if (periodType.value === 'quarter') return `Q${quarterSel.value || thisQuarter()} ${y}`;
  if (periodType.value === 'year')    return `Annual ${y}`;
  if (periodType.value === 'ytd')     return `YTD ${thisYear()}`;
  return 'Custom';
}
function pluralize(n, one, many){ return `${Number(n||0).toLocaleString()} ${Number(n)===1?one:many}`; }

// Preserve scroll during heavy DOM updates
function preserveScroll(fn){
  const y = window.scrollY;
  try { fn(); } finally { window.scrollTo(0, y); }
}

// ===== Narrative builder =====
function serviceNarrative(svcKey, yesCount, baseUSD, econUSD){
  const yesText = pluralize(yesCount, 'senior', 'seniors');
  const copy = {
    case_mgmt: (base, econ) =>
      `Tailored support packages helped ${yesText} avoid premature nursing-home placement, saving ${usd(base)} in direct costs and generating ${usd(econ)} in total economic impact.`,
    caregiver_respite: (base, econ) =>
      `Short-term caregiver relief stabilized households for ${yesText}, preventing costlier institutional care and saving ${usd(base)}; total impact reached ${usd(econ)}.`,
    hdm: (base, econ) =>
      `Reliable meal delivery maintained nutrition and independence for ${yesText}. Direct savings were ${usd(base)} with ${usd(econ)} in overall impact.`,
    crisis_intervention: (base, econ) =>
      `Rapid response and de-escalation for ${yesText} averted ER visits and placement risk, producing ${usd(base)} in direct savings and ${usd(econ)} in total economic impact.`
  };
  const f = copy[svcKey] || ((base, econ)=>`Targeted services supported ${yesText}, saving ${usd(base)} with ${usd(econ)} total impact.`);
  return f(baseUSD, econUSD);
}

// Build intro sentence without duplicating service names
function updateIntroSentence(clientsTotal, svcNames) {
  const period = periodLabel?.textContent || '—';
  const org = orgNameEl?.textContent || '(Organization Name)';
  const clientsText = clientsTotal.toLocaleString();
  const unique = [...new Set(svcNames.filter(Boolean))];

  let servicesPart = '';
  if (unique.length === 0) servicesPart = 'services';
  else if (unique.length === 1) servicesPart = `${unique[0]} services`;
  else servicesPart = `${unique[0]} and ${unique[1]} services`;

  if (introEl) {
    introEl.innerHTML = `In <span id="periodLabel">${period}</span>, <span id="orgName">${org}</span> surveyed <span id="clientsTotal">${clientsText}</span> clients receiving ${servicesPart}.`;
  }
}

// ===== Dynamic layout =====
function ensureSvcCardsRow(){
  const canvas = document.getElementById('reportCanvas');
  if (!canvas) return null;
  let row = document.getElementById('svcCards');
  if (!row) {
    const hero = taxpayerSavingsEl?.closest('.hero');
    row = document.createElement('div');
    row.id = 'svcCards';
    row.className = 'row';
    row.style.margin = '12px 0';
    row.style.alignItems = 'stretch';
    if (hero) canvas.insertBefore(row, hero); else canvas.appendChild(row);
  }
  return row;
}
function ensureVisualsSection(){
  const canvas = document.getElementById('reportCanvas');
  if (!canvas) return { bar:null, pie:null };
  let section = document.getElementById('svcVisuals');
  if (!section) {
    section = document.createElement('section');
    section.id = 'svcVisuals';
    section.className = 'grid grid-2';
    section.style.margin = '12px 0';
    const hero = taxpayerSavingsEl?.closest('.hero');
    if (hero) canvas.insertBefore(section, hero); else canvas.appendChild(section);

    // left: stacked bar
    const left = document.createElement('div');
    left.className = 'card-soft';
    left.style.minHeight = '320px';
    left.style.position = 'relative';
    left.innerHTML = `
      <div class="muted" style="text-align:center; margin-bottom:6px">Savings vs. Multiplier by Service</div>
      <div style="height:260px">
        <canvas id="svcStackedBar" role="img" aria-label="Savings versus multiplier by service" style="height:260px;width:100%"></canvas>
      </div>
    `;
    section.appendChild(left);

    // right: pie — impact composition
    const right = document.createElement('div');
    right.className = 'card-soft';
    right.style.minHeight = '320px';
    right.style.position = 'relative';
    right.innerHTML = `
      <div class="muted" style="text-align:center; margin-bottom:6px">Economic Impact Composition</div>
      <div style="height:260px">
        <canvas id="impactCompositionPie" role="img" aria-label="Economic impact composition" style="height:260px;width:100%"></canvas>
      </div>
    `;
    section.appendChild(right);
  }
  return {
    bar: document.getElementById('svcStackedBar'),
    pie: document.getElementById('impactCompositionPie')
  };
}

// ===== Charts =====
function destroyCharts(){
  if (svcStackedBarChart) { svcStackedBarChart.destroy(); svcStackedBarChart = null; }
  if (impactCompositionPie) { impactCompositionPie.destroy(); impactCompositionPie = null; }
}
async function ensureChartJs(){
  if (window.Chart) return;
  await import('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js');
}
async function renderCharts(perService, selectedKeys, multipliedSavings, taxes){
  await ensureChartJs();
  const { bar, pie } = ensureVisualsSection();
  if (!bar || !pie) return;

  bar.height = 260; pie.height = 260;

  // stacked bar: base vs multiplier by service
  const labels = selectedKeys.map(prettySvc);
  const baseVals = selectedKeys.map(k => (perService[k]?.savedBase || 0));
  const adjVals  = selectedKeys.map(k => (perService[k]?.savedAdjusted || 0));
  const multiplierOnly = adjVals.map((v, i) => Math.max(0, v - baseVals[i]));

  destroyCharts();

  svcStackedBarChart = new Chart(bar.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Healthcare System Savings', data: baseVals, stack:'s', borderWidth:0 },
        { label: 'Multiplier Effect',         data: multiplierOnly, stack:'s', borderWidth:0 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      resizeDelay: 200,
      scales:{
        x:{ stacked:true },
        y:{ stacked:true, beginAtZero:true, ticks:{ callback:(v)=>compactUSD(v) } }
      },
      plugins:{
        legend:{ position:'top' },
        tooltip:{ callbacks:{ label:(ctx)=>`${ctx.dataset.label}: ${usd(ctx.parsed.y)}` } }
      }
    }
  });

  // pie: economic impact composition (multiplied + taxes)
  const compLabels = [
    'Multiplied taxpayer savings',
    'Federal taxes',
    'State taxes',
    'Local taxes'
  ];
  const compData = [
    multipliedSavings || 0,
    taxes.federal || 0,
    taxes.state || 0,
    taxes.local || 0
  ];

  impactCompositionPie = new Chart(pie.getContext('2d'), {
    type: 'pie',
    data: { labels: compLabels, datasets: [{ data: compData }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      resizeDelay: 200,
      plugins:{
        legend:{ position:'right' },
        tooltip:{ callbacks:{ label:(ctx)=>`${ctx.label}: ${usd(ctx.parsed)}` } }
      }
    }
  });
}

// ================== UI wiring ==================
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

// ----- Surveys -----
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
      if (checkedCount > MAX) tgt.checked = false;
      reflectTitles();
    }
  });
  reflectTitles();
}

// ----- Clear -----
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
  if (multipliedSavingsEl) multipliedSavingsEl.textContent = '$—';

  const cards = document.getElementById('svcCards');
  if (cards) cards.innerHTML = '';
  destroyCharts();
  const visuals = document.getElementById('svcVisuals');
  if (visuals) visuals.remove();

  svc1SavedLabel.textContent = '$—';
  svc2SavedLabel.textContent = '$—';
  svc1Note.textContent = '—';
  svc2Note.textContent = '—';
  svcA.textContent = 'Case Management';
  svcB.textContent = 'Caregiver Respite';
  runNote.textContent = '';
  lastExport = null;
});

// ================== Core fetch + compute ==================
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

  // Require settings
  const REQUIRED = [
    'DEFAULT_NH_YEARLY','TAXPAYER_MULTIPLIER',
    'TAX_RATE_FEDERAL','TAX_RATE_STATE','TAX_RATE_LOCAL',
    'SPLIT_STATE_SHARE','SPLIT_FEDERAL_SHARE',
  ];
  const missing = REQUIRED.filter(k => isNaN(numParam(k)));
  if (missing.length) { runNote.textContent = `Missing/invalid settings: ${missing.join(', ')}.`; return; }

  const DEFAULT_NH_YEARLY   = numParam('DEFAULT_NH_YEARLY');
  const TAXPAYER_MULTIPLIER = numParam('TAXPAYER_MULTIPLIER');
  const TAX_RATE_FEDERAL    = numParam('TAX_RATE_FEDERAL');
  const TAX_RATE_STATE      = numParam('TAX_RATE_STATE');
  const TAX_RATE_LOCAL      = numParam('TAX_RATE_LOCAL');
  const SPLIT_STATE_SHARE   = numParam('SPLIT_STATE_SHARE');
  const SPLIT_FEDERAL_SHARE = numParam('SPLIT_FEDERAL_SHARE');

  const splitSum = SPLIT_STATE_SHARE + SPLIT_FEDERAL_SHARE;
  if (Math.abs(splitSum - 1) > 0.001) {
    runNote.textContent = `Warning: SPLIT_STATE_SHARE + SPLIT_FEDERAL_SHARE = ${splitSum.toFixed(3)} (expected 1.0).`;
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

  // Fetch county NH yearly per id
  const countyMap = Object.create(null);
  await Promise.all(Array.from(countyIds).map(async id => {
    try {
      const s = await getDoc(doc(db, 'countyCosts', id));
      countyMap[id] = s.exists() ? (s.data() || {}) : {};
    } catch { countyMap[id] = {}; }
  }));

  // Compute aggregates
  let yesTotal = 0;
  let noTotal = 0;
  let clientsTotal = 0;

  const perService = {
    case_mgmt: { yes:0, no:0, savedBase:0, savedAdjusted:0 },
    hdm: { yes:0, no:0, savedBase:0, savedAdjusted:0 },
    caregiver_respite: { yes:0, no:0, savedBase:0, savedAdjusted:0 },
    crisis_intervention: { yes:0, no:0, savedBase:0, savedAdjusted:0 },
  };

  for (const e of entries) {
    const id = docIdForCounty(e.state, e.county);
    const nhYearly = Number(countyMap[id]?.nhYearly);
    const nhUse = isFinite(nhYearly) ? nhYearly : DEFAULT_NH_YEARLY;
    const svcYearly = Number(e.avgCostYear) || 0;

    const yN = Number(e.yes) || 0;
    const nN = Number(e.no) || 0;

    yesTotal += yN;
    noTotal += nN;
    clientsTotal += (yN + nN);

    const baseAvoided = (nhUse - svcYearly) * frac;
    const savedBase = yN * baseAvoided;
    const savedAdjusted = savedBase * TAXPAYER_MULTIPLIER;

    if (perService[e.service]) {
      perService[e.service].yes += yN;
      perService[e.service].no  += nN;
      perService[e.service].savedBase += Math.max(0, savedBase);
      perService[e.service].savedAdjusted += Math.max(0, savedAdjusted);
    }
  }

  // Totals
  const taxpayerSavingsBase =
    perService.case_mgmt.savedBase +
    perService.hdm.savedBase +
    perService.caregiver_respite.savedBase +
    perService.crisis_intervention.savedBase;

  const multipliedSavings =
    perService.case_mgmt.savedAdjusted +
    perService.hdm.savedAdjusted +
    perService.caregiver_respite.savedAdjusted +
    perService.crisis_intervention.savedAdjusted;

  const taxes = {
    federal: multipliedSavings * TAX_RATE_FEDERAL,
    state:   multipliedSavings * TAX_RATE_STATE,
    local:   multipliedSavings * TAX_RATE_LOCAL,
  };

  const economicImpact = multipliedSavings + taxes.federal + taxes.state + taxes.local;

  const stateShare   = multipliedSavings * SPLIT_STATE_SHARE;
  const federalShare = multipliedSavings * SPLIT_FEDERAL_SHARE;

  // Bind to UI
  clientsTotalEl.textContent = clientsTotal.toLocaleString();
  yesTotalEl.textContent = yesTotal.toLocaleString();
  noTotalEl.textContent = noTotal.toLocaleString();

  taxpayerSavingsEl.textContent = usd(taxpayerSavingsBase);
  if (multipliedSavingsEl) multipliedSavingsEl.textContent = usd(multipliedSavings);

  fedEl.textContent = usd(taxes.federal);
  stateEl.textContent = usd(taxes.state);
  localEl.textContent = usd(taxes.local);
  economicImpactEl.textContent = usd(economicImpact);

  // ===== Per-service “Economic Translation” cards (TEXT ONLY) =====
  const cardsRow = ensureSvcCardsRow();
  if (cardsRow) {
    preserveScroll(() => {
      cardsRow.innerHTML = '';

      const selectedKeys = Array.from(services); // maintain Set order
      const totalAdjusted = selectedKeys.reduce((s,k)=> s + (perService[k]?.savedAdjusted || 0), 0);
      const totalTaxes = (taxes.federal||0) + (taxes.state||0) + (taxes.local||0);

      selectedKeys.forEach(k => {
        const v = perService[k] || {};
        const base = v.savedBase || 0;
        const adj = v.savedAdjusted || 0;
        const taxAlloc = totalAdjusted > 0 ? (adj / totalAdjusted) * totalTaxes : 0;
        const econ = adj + taxAlloc; // used only to phrase the narrative

        const card = document.createElement('div');
        card.className = 'card-soft';
        card.style.flex = '1 1 320px';
        card.style.minHeight = '110px';
        card.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px">
            <div class="pill">${prettySvc(k)}</div>
            <div style="font-weight:700; opacity:.9">Economic Translation</div>
          </div>
          <div class="sub" style="margin-top:4px">
            ${serviceNarrative(k, v.yes, base, econ)}
          </div>
        `;
        cardsRow.appendChild(card);
      });
    });

    // Charts (bar by service + total composition pie)
    await renderCharts(perService, Array.from(services), multipliedSavings, taxes);
  }
  // ===== End cards =====

  // Top two services by BASE savings (respect selected services)
  const ranked = Object.entries(perService)
    .filter(([k]) => services.has(k))
    .sort((a,b)=>b[1].savedBase-a[1].savedBase);

  const [s1, s2] = ranked;
  if (s1) {
    svc1SavedLabel.textContent = `${usd(s1[1].savedBase)} Saved — ${prettySvc(s1[0])}`;
    svc1Note.textContent = `${(s1[1].yes).toLocaleString()} clients avoided higher-cost care after receiving ${prettySvc(s1[0])}.`;
  } else {
    svc1SavedLabel.textContent = '$—';
    svc1Note.textContent = '—';
  }
  if (s2) {
    svc2SavedLabel.textContent = `${usd(s2[1].savedBase)} Saved — ${prettySvc(s2[0])}`;
    svc2Note.textContent = `${(s2[1].yes).toLocaleString()} clients avoided higher-cost care after receiving ${prettySvc(s2[0])}.`;
  } else {
    svc2SavedLabel.textContent = '$—';
    svc2Note.textContent = '—';
  }

  // Update intro sentence (no duplicate service names)
  const selectedPretty = getSelectedServices().map(prettySvc);
  const topA = s1 ? prettySvc(s1[0]) : selectedPretty[0];
  const topB = s2 ? prettySvc(s2[0]) : selectedPretty[1];
  updateIntroSentence(clientsTotal, [topA, topB]);

  // Keep spans populated for other parts of the page/exports
  svcA.textContent = topA || '—';
  svcB.textContent = topB || (selectedPretty[1] ? selectedPretty[1] : '—');

  runNote.textContent = `Report updated • ${entries.length.toLocaleString()} entries across ${countyIds.size} location(s).`;

  lastExport = {
    range,
    perService,
    taxpayerSavingsBase,
    multipliedSavings,
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

// ----- Export -----
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
  rows.push(['Taxpayer savings (BASE)', s.taxpayerSavingsBase]);
  rows.push(['Taxpayer savings (ADJUSTED)', s.multipliedSavings]);
  rows.push(['Economic impact', s.economicImpact]);
  rows.push(['Federal taxes', s.taxes.federal]);
  rows.push(['State taxes', s.taxes.state]);
  rows.push(['Local taxes', s.taxes.local]);
  rows.push(['State share of adjusted savings', s.savingsSplit.stateShare]);
  rows.push(['Federal share of adjusted savings', s.savingsSplit.federalShare]);
  rows.push([]);
  rows.push(['Survey','Value']);
  rows.push(['Survey ID', s.surveyContext.surveyId || '(none)']);
  rows.push(['Question 1', s.surveyContext.q1Title || '']);
  rows.push(['Question 2', s.surveyContext.q2Title || '']);
  rows.push(['Question 3', s.surveyContext.q3Title || '']);
  rows.push([]);
  rows.push(['Service','Yes','No','Saved (BASE)','Saved (ADJUSTED)']);
  for (const [k,v] of Object.entries(s.perService)) {
    if (!selected.has(k)) continue;
    rows.push([prettySvc(k), v.yes, v.no, v.savedBase, v.savedAdjusted]);
  }

  const csv = rows.map(r => r.join('\n').replace(/\n/g, ' ')).join('\n'); // simple sanitize
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'policyworth-report.csv';
  a.click();
});

// ----- Auth -----
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  currentUid = user.uid;
  await loadConfig();
  await loadSurveys();
  // runReport(); // optional auto-run
});
