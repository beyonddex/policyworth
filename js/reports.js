// /js/reports.js
import { auth, db } from '/js/auth.js';
import {
  collection, query, where, getDocs, doc, getDoc
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

const runNote = $('#runNote');

// Settings (could come from /config later)
const DEFAULTS = {
  defaultNhYearly: 68000,                 // $68k -> $17k per quarter
  economicMultiplier: 1.58,               // matches mock
  taxRates: { federal: 0.275, state: 0.04375, local: 0.01125 }
};

let currentUid = null;
let lastExport = null;
let htmlToImage = null;

// ----- Helpers
const pad = (n)=> String(n).padStart(2,'0');
const thisYear = ()=> (new Date()).getFullYear();
const thisQuarter = ()=>{
  const m = (new Date()).getMonth()+1;
  return m<=3?1:m<=6?2:m<=9?3:4;
};

function quarterRange(y, q){
  const startMonth = {1:1, 2:4, 3:7, 4:10}[q];
  const from = `${y}-${pad(startMonth)}-01`;
  const endDay = new Date(y, startMonth + 2, 0).getDate(); // last day of quarter
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

// Build the “period label” string without fetching
function currentPeriodLabel(){
  const y = Number(yearSel.value || thisYear());
  if (periodType.value === 'quarter') return `Q${quarterSel.value || thisQuarter()} ${y}`;
  if (periodType.value === 'year') return `Year ${y}`;
  if (periodType.value === 'ytd') return `YTD ${thisYear()}`;
  return 'Custom';
}

// ----- UI wiring

// Populate years: current year first, down to 1980
(function fillYears(){
  const start = thisYear();
  const opts = [];
  for (let y = start; y >= 1980; y--) {
    const sel = y === start ? ' selected' : '';
    opts.push(`<option value="${y}"${sel}>${y}</option>`);
  }
  yearSel.innerHTML = opts.join('');
})();

// Defaults on first load
(function initDefaults(){
  quarterSel.value = String(thisQuarter());
  periodType.value = 'quarter';
  qWrap.style.display = '';
  fromWrap.style.display = toWrap.style.display = 'none';
  updatePeriodLabels(); // initialize the header labels
})();

// Show/hide inputs for the selected period + update labels
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

// Update labels (no fetch)
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

// Clear: reset to defaults and wipe numbers so it doesn’t look stale
clearBtn.addEventListener('click', () => {
  periodType.value = 'quarter';
  quarterSel.value = String(thisQuarter());
  yearSel.value = String(thisYear());
  dateFrom.value = '';
  dateTo.value = '';
  // Leave chips as-is (or uncomment next line to check all by default on Clear)
  servicesWrap.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  updateVisibleControls();

  // Reset numbers
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

// ----- Core fetch + compute
async function runReport(){
  if (!currentUid) return;

  // Ensure at least one service
  const selectedSvcs = getSelectedServices();
  if (selectedSvcs.length === 0) {
    runNote.textContent = 'Select at least one service.';
    return;
  }

  // Resolve date range + validate custom
  const y = Number(yearSel.value || thisYear());
  let range;
  if (periodType.value === 'quarter') range = quarterRange(y, Number(quarterSel.value || thisQuarter()));
  else if (periodType.value === 'year') range = yearRange(y);
  else if (periodType.value === 'ytd') range = ytdRange();
  else {
    const f = dateFrom.value;
    const t = dateTo.value;
    if (!f || !t) { runNote.textContent = 'Pick both start and end dates for Custom.'; return; }
    if (f > t) { runNote.textContent = '“From” must be before “To”.'; return; }
    range = { from: f, to: t };
  }

  const { from, to } = range;
  rangeLabel.textContent = `${from} → ${to}`;
  periodLabel.textContent = currentPeriodLabel();
  runNote.textContent = 'Running…';

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

  // Compute aggregates
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
    const nhYearly = Number(countyMap[id]?.nhYearly) || DEFAULTS.defaultNhYearly;
    const nhQuarter = nhYearly / 4;
    const svcQuarter = (Number(e.avgCostYear) || 0) / 4;

    const yN = Number(e.yes) || 0;
    const nN = Number(e.no) || 0;

    yesTotal += yN;
    noTotal += nN;
    clientsTotal += (yN + nN);

    const saved = yN * (nhQuarter - svcQuarter);
    if (perService[e.service]) {
      perService[e.service].yes += yN;
      perService[e.service].no  += nN;
      perService[e.service].saved += saved;
    }
  }

  const taxpayerSavings =
    perService.case_mgmt.saved +
    perService.hdm.saved +
    perService.caregiver_respite.saved +
    perService.crisis_intervention.saved;

  const taxes = {
    federal: taxpayerSavings * DEFAULTS.taxRates.federal,
    state:   taxpayerSavings * DEFAULTS.taxRates.state,
    local:   taxpayerSavings * DEFAULTS.taxRates.local,
  };

  const economicImpact = taxpayerSavings * DEFAULTS.economicMultiplier;

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

  // Reflect those in the intro sentence (fallback to any selected services)
  const selectedPretty = selectedSvcs.map(prettySvc);
  svcA.textContent = (s1 ? prettySvc(s1[0]) : selectedPretty[0] || '—');
  svcB.textContent = (s2 ? prettySvc(s2[0]) : selectedPretty[1] || selectedPretty[0] || '—');

  // Note
  runNote.textContent = `Report updated • ${entries.length.toLocaleString()} entries across ${countyIds.size} location(s).`;

  // Save last export for CSV
  lastExport = { range, perService, taxpayerSavings, economicImpact, taxes, clientsTotal, yesTotal, noTotal };
}

runBtn.addEventListener('click', runReport);

// Allow pressing Enter on any control to run (nice UX)
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

  // Only export selected services; also use pretty names
  const selected = new Set(getSelectedServices());
  const rows = [];
  rows.push(['Metric','Value']);
  rows.push(['From', s.range.from]);
  rows.push(['To', s.range.to]);
  rows.push(['Clients total', s.clientsTotal]);
  rows.push(['Yes', s.yesTotal]);
  rows.push(['No', s.noTotal]);
  rows.push(['Taxpayer savings', s.taxpayerSavings]);
  rows.push(['Economic impact', s.economicImpact]);
  rows.push(['Federal taxes', s.taxes.federal]);
  rows.push(['State taxes', s.taxes.state]);
  rows.push(['Local taxes', s.taxes.local]);
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
onAuthStateChanged(auth, (user) => {
  if (!user) return;
  currentUid = user.uid;
  // Optional: auto-run current quarter on load
  // runReport();
});
