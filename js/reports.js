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
const servicesSel = $('#services');

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

// Settings (can be replaced by /configPublic if you add it later)
const DEFAULTS = {
  defaultNhYearly: 68000,                 // $68k -> $17k per quarter
  economicMultiplier: 1.58,               // matches your mock
  taxRates: { federal: 0.275, state: 0.04375, local: 0.01125 }
};

let currentUid = null;

// ----- Helpers
function pad(n){ return String(n).padStart(2,'0'); }

function quarterRange(y, q){
  const startMonths = {1:1, 2:4, 3:7, 4:10};
  const m0 = startMonths[q];
  const from = `${y}-${pad(m0)}-01`;
  const end = new Date(y, m0+2, 0).getDate(); // last day of quarter
  const to = `${y}-${pad(m0+2)}-${pad(end)}`;
  return { from, to };
}

function yearRange(y){
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

function ytdRange(){
  const now = new Date();
  return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}` };
}

function getSelectedServices(){
  return Array.from(servicesSel.selectedOptions).map(o => o.value);
}

function usd(n){
  if (!isFinite(n)) return '$—';
  return n.toLocaleString(undefined, { style:'currency', currency:'USD', maximumFractionDigits:0 });
}

function docIdForCounty(state, county){
  const slug = String(county).trim().replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  return `${String(state).toUpperCase()}__${slug}`;
}

// ----- UI wiring
(periodType).addEventListener('change', () => {
  const t = periodType.value;
  qWrap.style.display = (t === 'quarter') ? '' : 'none';
  fromWrap.style.display = toWrap.style.display = (t === 'custom') ? '' : 'none';
});

(function fillYears(){
  const nowY = new Date().getFullYear();
  const years = [];
  for (let y = nowY + 1; y >= nowY - 6; y--) years.push(`<option value="${y}" ${y===nowY?'selected':''}>${y}</option>`);
  yearSel.innerHTML = years.join('');
})();

clearBtn.addEventListener('click', () => {
  servicesSel.querySelectorAll('option').forEach(o => o.selected = true);
});

// ----- Core fetch + compute
async function runReport(){
  if (!currentUid) return;

  // 1) Resolve date range
  const y = Number(yearSel.value);
  let range;
  if (periodType.value === 'quarter') range = quarterRange(y, Number(quarterSel.value));
  else if (periodType.value === 'year') range = yearRange(y);
  else if (periodType.value === 'ytd') range = ytdRange();
  else range = { from: dateFrom.value, to: dateTo.value };

  const { from, to } = range;
  rangeLabel.textContent = `${from} → ${to}`;
  periodLabel.textContent =
    periodType.value === 'quarter' ? `Q${quarterSel.value} ${y}` :
    periodType.value === 'year' ? `Year ${y}` :
    periodType.value === 'ytd' ? `YTD ${new Date().getFullYear()}` : `Custom Range`;

  // 2) Pull tallies in range
  const services = new Set(getSelectedServices()); // filter set
  const qRef = query(
    collection(db, 'users', currentUid, 'tallies'),
    where('date', '>=', from),
    where('date', '<=', to)
  );
  const snap = await getDocs(qRef);

  // 3) Collect unique locations for county cost fetch
  const entries = [];
  const countyIds = new Set();
  snap.forEach(d => {
    const e = d.data() || {};
    if (!services.has(e.service)) return;
    if (!e.state || !e.county) return;
    entries.push(e);
    countyIds.add(docIdForCounty(e.state, e.county));
  });

  // 4) Fetch county NH yearly for each unique id (batched)
  const countyMap = Object.create(null);
  await Promise.all(Array.from(countyIds).map(async id => {
    try {
      const s = await getDoc(doc(db, 'countyCosts', id));
      countyMap[id] = s.exists() ? (s.data() || {}) : {};
    } catch { countyMap[id] = {}; }
  }));

  // 5) Compute aggregates
  let yesTotal = 0;
  let noTotal = 0;
  let clientsTotal = 0;

  // per-service
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
    perService[e.service].yes += yN;
    perService[e.service].no  += nN;
    perService[e.service].saved += saved;
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

  // 6) Bind to UI
  clientsTotalEl.textContent = (clientsTotal).toLocaleString();
  yesTotalEl.textContent = (yesTotal).toLocaleString();
  noTotalEl.textContent = (noTotal).toLocaleString();

  taxpayerSavingsEl.textContent = usd(taxpayerSavings);
  fedEl.textContent = usd(taxes.federal);
  stateEl.textContent = usd(taxes.state);
  localEl.textContent = usd(taxes.local);
  economicImpactEl.textContent = usd(economicImpact);

  // show top two services by saved
  const svcPretty = {
    case_mgmt: 'Case Management',
    hdm: 'Home-Delivered Meals',
    caregiver_respite: 'Caregiver Respite',
    crisis_intervention: 'Crisis Intervention',
  };
  const ranked = Object.entries(perService).sort((a,b)=>b[1].saved-a[1].saved);
  const [s1, s2] = ranked;
  if (s1) {
    svc1SavedLabel.textContent = `${usd(s1[1].saved)} Saved — ${svcPretty[s1[0]]}`;
    svc1Note.textContent = `${(s1[1].yes).toLocaleString()} clients avoided higher-cost care after receiving ${svcPretty[s1[0]]}.`;
  } else {
    svc1SavedLabel.textContent = '$—';
    svc1Note.textContent = '—';
  }
  if (s2) {
    svc2SavedLabel.textContent = `${usd(s2[1].saved)} Saved — ${svcPretty[s2[0]]}`;
    svc2Note.textContent = `${(s2[1].yes).toLocaleString()} clients avoided higher-cost care after receiving ${svcPretty[s2[0]]}.`;
  } else {
    svc2SavedLabel.textContent = '$—';
    svc2Note.textContent = '—';
  }

  // note: period label for intro
  const label =
    periodType.value === 'quarter' ? `Q${quarterSel.value} ${y}` :
    periodType.value === 'year' ? `Year ${y}` :
    periodType.value === 'ytd' ? `YTD ${new Date().getFullYear()}` : `Custom`;
  periodLabel.textContent = label;

  // attach last result for CSV export
  lastExport = { range, perService, taxpayerSavings, economicImpact, taxes, clientsTotal, yesTotal, noTotal };
}

runBtn.addEventListener('click', runReport);

// ----- Export
printBtn.addEventListener('click', () => window.print());

let htmlToImage; // lazy load
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

let lastExport = null;
csvBtn.addEventListener('click', () => {
  if (!lastExport) return;
  const lines = [];
  const s = lastExport;
  lines.push(['Metric','Value'].join(','));
  lines.push(['Clients total', s.clientsTotal]);
  lines.push(['Yes', s.yesTotal]);
  lines.push(['No', s.noTotal]);
  lines.push(['Taxpayer savings', s.taxpayerSavings]);
  lines.push(['Economic impact', s.economicImpact]);
  lines.push(['Federal taxes', s.taxes.federal]);
  lines.push(['State taxes', s.taxes.state]);
  lines.push(['Local taxes', s.taxes.local]);
  lines.push([]);
  lines.push(['Service','Yes','No','Saved'].join(','));
  for (const [k,v] of Object.entries(s.perService)) {
    lines.push([k, v.yes, v.no, v.saved].join(','));
  }
  const blob = new Blob([lines.map(r=>Array.isArray(r)?r.join(','):r).join('\n')], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'policyworth-report.csv';
  a.click();
});

// ----- Auth
onAuthStateChanged(auth, (user) => {
  if (!user) return;
  currentUid = user.uid;
  // optional: auto-run current quarter on load
  // runReport();
});
