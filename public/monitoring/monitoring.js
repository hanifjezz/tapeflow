/* =========================================================
   Tapeflow Monitoring — Production-ready (Vercel)
   - API base ke origin: /api (bisa ganti ke URL publik)
   - Fallback jika /devices dan /sensors tidak tersedia
   - Anti-race: loadSeq
   - Hard clamp data by [from, to)
   - No-cache fetch
========================================================= */
'use strict';

/* =======================
   KONFIG
======================= */
const API               = window.__API_BASE || '/api'; // ganti ke 'https://api-kamu.domain' bila backend terpisah
const TZ_OFFSET_MINUTES = 420;  // WIB (+7)
const POLL_MS           = 5000;
const TABLE_LIMIT       = 500;
const THRESH            = { low: 25, high: 35 };
const PALETTE           = ['#4da3ff', '#8b6cff', '#18a0aa', '#ff5a5f', '#eab308'];
const WIB_TZ            = 'Asia/Jakarta';

/* =======================
   STATE
======================= */
let chart, gradient;
let poller = null;
let sensorCache = [];          // {id, name}[]
let deviceCache = [];          // {id, name, location?}[]
let selectedSensor = 'all';    // 'all' | 'A' | 'B' | '1' | ...
let selectedDevice = null;     // device id | null
let activePreset   = '1h';     // '1m'|'1h'|'1d'|'2d'
let activeDateRange = null;    // {from:Date, to:Date} | null
let loadSeq = 0;               // guard anti-race

/* =======================
   DOM
======================= */
const deviceSelect = document.getElementById('deviceSelect');
const btnRefresh   = document.getElementById('btnRefresh');
const sensorChips  = document.getElementById('sensorChips');
const tbody        = document.getElementById('tbody');

const chipNow = document.getElementById('chipNow');
const chipMin = document.getElementById('chipMin');
const chipAvg = document.getElementById('chipAvg');
const chipMax = document.getElementById('chipMax');

document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) window.lucide.createIcons();
});

/* =======================
   UTIL WAKTU (WIB)
======================= */
function toMySQLLocal(dt){
  const p = n => String(n).padStart(2,'0');
  return `${dt.getFullYear()}-${p(dt.getMonth()+1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}
function startOfMinute(d){ const x = new Date(d); x.setSeconds(0,0); return x; }
function endExclusive(d){ return new Date(d.getTime()+1); }
function startOfDay(d){ const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDayExclusive(d){ const x = startOfDay(d); x.setDate(x.getDate()+1); return x; }

function fmtWIB(ts, withTime=true){
  const opt = {
    timeZone: WIB_TZ,
    year:'numeric', month:'2-digit', day:'2-digit',
    ...(withTime ? {hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false} : {})
  };
  return new Intl.DateTimeFormat('id-ID', opt).format(new Date(ts)) + (withTime ? ' WIB' : '');
}

/* Label sumbu-X TANPA “WIB” */
function fmtAxisNoWIB(ts, unit='minute'){
  const d = new Date(ts);
  const base = unit === 'second'
    ? { hour:'2-digit', minute:'2-digit', second:'2-digit' }
    : unit === 'hour'
      ? { hour:'2-digit' }
      : { hour:'2-digit', minute:'2-digit' };
  return new Intl.DateTimeFormat('id-ID', { ...base, hour12:false, timeZone:WIB_TZ }).format(d);
}

/* =======================
   EMPTY STATE UI
======================= */
function showEmptyState(on){
  const el = document.getElementById('empty-state'); // opsional
  if (el) el.style.display = on ? 'flex' : 'none';
}

/* =======================
   STATISTIK
======================= */
function stats(rows){
  if (!rows || !rows.length) return { now:'—', min:'—', avg:'—', max:'—' };
  const ys = rows.map(r => Number(r.temperature ?? r.y)).filter(n => !isNaN(n));
  if (!ys.length) return { now:'—', min:'—', avg:'—', max:'—' };
  const now = ys[ys.length-1];
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const avg = ys.reduce((a,b)=>a+b,0)/ys.length;
  return { now: now.toFixed(1), min:min.toFixed(1), avg:avg.toFixed(1), max:max.toFixed(1) };
}
function applyStats(s){
  if (chipNow) chipNow.textContent = `now ${s.now}`;
  if (chipMin) chipMin.textContent = `min ${s.min}`;
  if (chipAvg) chipAvg.textContent = `avg ${s.avg}`;
  if (chipMax) chipMax.textContent = `max ${s.max}`;
  const big = document.getElementById('bigTemp');
  if (big) big.textContent = s.now ?? '—';
  const lu = document.getElementById('lastUpdate');
  if (lu){
    lu.textContent = new Intl.DateTimeFormat('id-ID',{
      timeZone: WIB_TZ, hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
    }).format(new Date());
  }
}

/* =======================
   CHART
======================= */
function ensureChart(){
  if (chart) return;
  const canvas = document.getElementById('tempChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0,0,0,300);
  g.addColorStop(0, 'rgba(91,140,255,0.25)');
  g.addColorStop(1, 'rgba(91,140,255,0.00)');
  gradient = g;

  chart = new Chart(ctx, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      elements: { point:{ radius:0 }, line:{ tension:0.25, borderWidth:2 } },
      scales: {
        x: {
          type: 'time',
          time: {
            unit:'minute',
            stepSize: 2,
            displayFormats: { second:'HH:mm:ss', minute:'HH:mm', hour:'HH' }
          },
          bounds: 'ticks',
          ticks: {
            maxRotation: 0,
            autoSkip: true,
            callback: (v) => fmtAxisNoWIB(v, chart?.options?.scales?.x?.time?.unit ?? 'minute')
          },
          distribution: 'linear'
        },
        y: { beginAtZero:false, suggestedMin:24, suggestedMax:36 }
      },
      plugins: { legend: { position:'top' } }
    }
  });
}

/* =======================
   RANGE / PRESET
======================= */
function computeRangeAnchored(){
  const now = new Date();

  if (activeDateRange){
    const from = activeDateRange.from;
    const to   = activeDateRange.to;
    const spanSec = Math.max(1, Math.round((to - from)/1000));

    let intervalSec, unit, step;
    if (spanSec <= 3600)         { intervalSec = 2;    unit='second'; step=2; }
    else if (spanSec <= 6*3600)  { intervalSec = 120;  unit='minute'; step=2; }
    else if (spanSec <= 2*86400) { intervalSec = 3600; unit='hour';   step=1; }
    else                         { intervalSec = 7200; unit='hour';   step=2; }
    return { from, to, intervalSec, unit, step };
  }

  const m0 = startOfMinute(now);

  if (activePreset === '1m'){
    const to = new Date(m0.getTime() + 60*1000);
    const from = new Date(to.getTime() - 60*1000);
    return { from, to, intervalSec:2, unit:'second', step:2 };
  }
  if (activePreset === '1h'){
    const to = new Date(m0.getTime() + 60*1000);
    const from = new Date(to.getTime() - 60*60*1000);
    return { from, to, intervalSec:120, unit:'minute', step:2 };
  }
  if (activePreset === '1d'){
    const start = startOfDay(now);
    const from = start;
    const to   = endOfDayExclusive(now);
    return { from, to, intervalSec:3600, unit:'hour', step:1 };
  }
  if (activePreset === '2d'){
    const start = startOfDay(now);
    const from = new Date(start); from.setDate(from.getDate()-1);
    const to   = new Date(start); to.setDate(to.getDate()+1);
    return { from, to, intervalSec:3600, unit:'hour', step:1 };
  }

  const to = endExclusive(m0);
  const from = new Date(to.getTime() - 60*60*1000);
  return { from, to, intervalSec:120, unit:'minute', step:2 };
}

/* =======================
   DEVICES / SENSORS (dengan fallback)
======================= */
async function safeJSON(res){
  const text = await res.text();
  try { return JSON.parse(text); } catch { return {}; }
}

// Urutkan "Wadah A", "Wadah B", ...; lalu ID angka 1,2,3...
function sensorSort(a, b) {
  const A = String(a.id ?? a.name ?? '').toUpperCase();
  const B = String(b.id ?? b.name ?? '').toUpperCase();

  const isLetter = v => /^[A-Z]$/.test(v);
  const isNumber = v => /^\d+$/.test(v);

  if (isLetter(A) && isLetter(B)) return A.localeCompare(B); // A,B,C...
  if (isNumber(A) && isNumber(B)) return Number(A) - Number(B);
  if (isLetter(A) && isNumber(B)) return -1; // huruf dulu, baru angka
  if (isNumber(A) && isLetter(B)) return 1;
  return (a.name || '').localeCompare(b.name || '');
}

async function loadDevices(){
  if (!deviceSelect) return;
  try{
    const res = await fetch(`${API}/devices`, { cache: 'no-store' });
    if (!res.ok) throw new Error('no /devices');
    const devs = await safeJSON(res);
    deviceCache = Array.isArray(devs) ? devs : (devs.devices || []);
  }catch{
    deviceCache = [];
  }

  if (deviceCache.length){
    deviceSelect.innerHTML = deviceCache.map(d => `<option value="${d.id}">${d.name} — ${d.location || '-'}</option>`).join('');
    const saved = localStorage.getItem('tapeflow_device');
    selectedDevice = saved && deviceCache.some(d=>String(d.id)===saved) ? saved : String(deviceCache[0].id);
    deviceSelect.value = selectedDevice;
    localStorage.setItem('tapeflow_device', selectedDevice);
    deviceSelect.parentElement?.classList.remove('hidden');
  } else {
    selectedDevice = null;
    deviceSelect.innerHTML = '';
    deviceSelect.parentElement?.classList.add('hidden');
  }
}

async function loadSensors(){
  if (!sensorChips) return;

  let sensors = [];

  // 1) coba endpoint khusus
  if (selectedDevice){
    try{
      const res = await fetch(`${API}/sensors?device_id=${encodeURIComponent(selectedDevice)}`, { cache: 'no-store' });
      if (res.ok){
        const js = await safeJSON(res);
        sensors = Array.isArray(js) ? js : (js.sensors || []);
      }
    }catch{}
  }

  // 2) fallback dari /measurements (series)
  if (!sensors.length){
    try{
      const { from, to } = computeRangeAnchored();
      const qs = new URLSearchParams({
        from: toMySQLLocal(from), to: toMySQLLocal(to),
        tzOffsetMinutes: String(TZ_OFFSET_MINUTES)
      });
      const res = await fetch(`${API}/measurements?${qs}`, { cache: 'no-store' });
      if (res.ok){
        const js = await safeJSON(res);
        if (Array.isArray(js.series)) {
          sensors = js.series.map((s, i) => ({
            id: String(s.id ?? String.fromCharCode(65 + i)), // A,B,C default
            name: s.name || `Wadah ${String(s.id ?? String.fromCharCode(65 + i))}`
          }));
        } else if (Array.isArray(js.rows)) {
          sensors = [{ id: 'A', name: 'Wadah A' }];
        }
      }
    }catch{}
  }

  // 3) urutkan A,B,C,... lalu angka
  sensors.sort(sensorSort);
  sensorCache = sensors.slice();

  // 4) render chips (ID disimpan sbg STRING!)
  const keep = selectedSensor;
  sensorChips.innerHTML =
    `<button class="sensor-pill ${keep === 'all' ? 'active' : ''}" data-sid="all">All</button>` +
    sensors.map(s => `<button class="sensor-pill ${keep === String(s.id) ? 'active' : ''}" data-sid="${String(s.id)}">${s.name}</button>`).join('');

  sensorChips.querySelectorAll('.sensor-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      sensorChips.querySelectorAll('.sensor-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedSensor = btn.dataset.sid === 'all' ? 'all' : String(btn.dataset.sid);
      localStorage.setItem('tapeflow_sensor', selectedSensor);
      loadMeasurements();
    });
  });

  // 5) restore pilihan
  const saved = localStorage.getItem('tapeflow_sensor');
  if (saved && (saved === 'all' || sensors.some(s => String(s.id) === saved))) {
    selectedSensor = saved;
    sensorChips.querySelector(`[data-sid="${saved}"]`)?.classList.add('active');
  } else {
    selectedSensor = 'all';
    sensorChips.querySelector(`[data-sid="all"]`)?.classList.add('active');
    localStorage.setItem('tapeflow_sensor', 'all');
  }
}

/* =======================
   HELPER CLAMP
======================= */
function clampRows(rows, from, to){
  return (rows || [])
    .map(r => ({
      x: new Date(r.timestamp ?? r.x),
      y: r.temperature != null ? Number(r.temperature) : (r.y != null ? Number(r.y) : null),
      name: r.name
    }))
    .filter(p => p.x >= from && p.x < to)
    .sort((a,b) => a.x - b.x);
}

/* =======================
   LOAD DATA (anti-race + no-fallback + hard clamp)
======================= */
async function loadMeasurements(){
  ensureChart();
  if (!chart) return;

  const mySeq = ++loadSeq; // token batch ini
  const { from, to, intervalSec, unit, step } = computeRangeAnchored();

  // kunci domain X & format
  chart.options.scales.x.time.unit = unit;
  chart.options.scales.x.time.stepSize = step;
  chart.options.scales.x.time.displayFormats = { second:'HH:mm:ss', minute:'HH:mm', hour:'HH' };
  chart.options.scales.x.min = from.getTime();
  chart.options.scales.x.max = to.getTime();

  // susun query (kompat: from/to & start/end)
  const qs = new URLSearchParams({
    tzOffsetMinutes: String(TZ_OFFSET_MINUTES),
    interval: String(intervalSec),
    from:  toMySQLLocal(from), to: toMySQLLocal(to),
    start: toMySQLLocal(from), end: toMySQLLocal(to)
  });
  if (selectedDevice) qs.set('device_id', String(selectedDevice));

  try{
    const res = await fetch(`${API}/measurements?${qs}`, { cache: 'no-store' });
    if (mySeq !== loadSeq) return; // abaikan hasil usang
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const js = await safeJSON(res);

    let datasets = [];
    let tableRows = [];

    if (Array.isArray(js.series)) {
      // urutkan series agar konsisten (A,B,C,... lalu angka)
      const sortedSeries = js.series.slice().sort((a, b) => {
        return sensorSort(
          { id: String(a.id ?? ''), name: a.name },
          { id: String(b.id ?? ''), name: b.name }
        );
      });

      // filter sesuai chip
      const usedSeries = sortedSeries.filter((s, idx) => {
        const sid = String(s.id ?? String.fromCharCode(65 + idx)); // 'A','B',...
        return selectedSensor === 'all' || selectedSensor === sid;
      });

      usedSeries.forEach((s, idx) => {
        const sid = String(s.id ?? String.fromCharCode(65 + idx));
        const label = s.name || `Wadah ${sid}`;
        const raw = (s.rows || [])
          .map(r => ({ x:new Date(r.timestamp), y:r.temperature==null?null:Number(r.temperature), name: label }))
          .sort((a,b)=>a.x-b.x);
        const clamped = raw.filter(p => p.x >= from && p.x < to);

        datasets.push({
          label,
          data: clamped,
          borderColor: PALETTE[idx % PALETTE.length],
          backgroundColor: selectedSensor === 'all' ? 'transparent' : gradient,
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0,
          spanGaps: true,
          fill: selectedSensor !== 'all'
        });

        tableRows = tableRows.concat(clamped.map(r => ({ timestamp: r.x, temperature: r.y, name: label })));
      });
    } else if (Array.isArray(js.rows)) {
      const raw = js.rows.map(r => ({
        x:new Date(r.timestamp),
        y:r.temperature==null?null:Number(r.temperature),
        name: r.name ?? r.sensor ?? 'Sensor 1'
      })).sort((a,b)=>a.x-b.x);
      const clamped = raw.filter(p => p.x >= from && p.x < to);
      datasets = [{
        label: selectedSensor==='all' ? 'Suhu (°C)' : `Sensor ${selectedSensor}`,
        data: clamped,
        borderWidth: 2,
        borderColor: PALETTE[0],
        backgroundColor: gradient,
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        spanGaps: true
      }];
      tableRows = clamped.map(r => ({ timestamp: r.x, temperature: r.y, name: r.name }));
    } else {
      datasets = [];
      tableRows = [];
    }

    const totalPoints = datasets.reduce((n,d)=>n + d.data.length, 0);
    if (!totalPoints){
      chart.data.datasets = [];
      chart.update();
      applyStats({ now:'—', min:'—', avg:'—', max:'—' });
      if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="muted">Tidak ada data pada rentang yang dipilih.</td></tr>`;
      showEmptyState(true);
      return;
    }

    chart.data.datasets = datasets;

    // scale Y dinamis termasuk threshold
    const allY = datasets.flatMap(d => d.data.map(p => p.y).filter(v => v != null));
    if (allY.length) {
      chart.options.scales.y.suggestedMin = Math.floor(Math.min(...allY, THRESH.low) - 1);
      chart.options.scales.y.suggestedMax = Math.ceil(Math.max(...allY, THRESH.high) + 1);
    }
    chart.update();
    showEmptyState(false);

    // Statistik
    applyStats(stats(tableRows.map(r => ({ temperature:r.temperature }))));

    // Tabel (DESC)
    tableRows.sort((a,b)=> b.timestamp - a.timestamp);
    const view = tableRows.slice(0, TABLE_LIMIT);
    if (tbody){
      tbody.innerHTML = view.length
        ? view.map((r, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${fmtWIB(r.timestamp, true)}</td>
              <td>${r.temperature == null ? '-' : Number(r.temperature).toFixed(2)}${r.name?` — <span class="muted">${r.name}</span>`:''}</td>
            </tr>
          `).join('')
        : `<tr><td colspan="3" class="muted">Tidak ada data pada rentang yang dipilih.</td></tr>`;
    }
  }catch(err){
    console.error('loadMeasurements failed:', err);
    if (chart){
      chart.data.datasets = [];
      chart.update();
    }
    applyStats({ now:'—', min:'—', avg:'—', max:'—' });
    if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="muted">Gagal memuat data.</td></tr>`;
    showEmptyState(true);
  }
}

/* =======================
   POLLING
======================= */
function startPolling(){
  stopPolling();
  if (activeDateRange) return; // mode tanggal: polling off
  poller = setInterval(() => {
    if (!activeDateRange) loadMeasurements();
  }, POLL_MS);
}
function stopPolling(){ if (poller){ clearInterval(poller); poller = null; } }

/* =======================
   DATE PICKER — Inline Modal (center)
======================= */
(function setupInlineCalendarModal(){
  const wrapBtn   = document.getElementById('dateWrap');
  const labelEl   = document.getElementById('dateLabel');
  const modal     = document.getElementById('tfDateModal');
  const host      = document.getElementById('tfCalendarHost');
  const btnApply  = document.getElementById('tfDateApply');
  const btnCancel = document.getElementById('tfDateCancel');
  const btnClose  = document.getElementById('tfDateClose');

  if (!wrapBtn || !labelEl || !modal || !host) return;

  function setDateLabel(from, to){
    const fmt = new Intl.DateTimeFormat('id-ID',{ timeZone:WIB_TZ, day:'2-digit', month:'2-digit', year:'numeric' });
    const f = fmt.format(from);
    const t = fmt.format(new Date(to.getTime()-1));
    labelEl.textContent = (f===t ? f : `${f}–${t}`);
  }
  function resetDateLabel(){ labelEl.textContent = 'hh/bb/tttt'; }

  let fp = null;
  let sel = [];

  function openModal(){
    host.innerHTML = '';
    if (fp && fp.destroy) { try{ fp.destroy(); }catch{} fp=null; }

    let defaultDate = undefined;
    if (window.activeDateRange?.from){
      const f = new Date(window.activeDateRange.from);
      const t = new Date(window.activeDateRange.to); t.setMilliseconds(t.getMilliseconds()-1);
      defaultDate = [f, t];
    }

    fp = flatpickr(host, {
      inline: true,
      mode: 'range',
      dateFormat: 'Y-m-d',
      time_24hr: true,
      disableMobile: true,
      defaultDate,
      onReady: (_, __, inst) => { sel = inst.selectedDates.slice(); },
      onChange: (dates) => { sel = dates.slice(); }
    });

    modal.classList.add('show');
    document.body.classList.add('modal-open');
    window.stopPolling?.();
  }

  function closeModal(){
    modal.classList.remove('show');
    document.body.classList.remove('modal-open');
  }

  wrapBtn.addEventListener('click', openModal);

  btnApply?.addEventListener('click', () => {
    if (sel.length === 1){
      const from = startOfDay(sel[0]);
      const to   = endOfDayExclusive(sel[0]);
      window.activeDateRange = { from, to };
      wrapBtn.classList.add('active');
      document.querySelectorAll('.ranges .pill[data-preset]').forEach(b=>b.classList.remove('active'));
      setDateLabel(from, to);
      closeModal();
      loadMeasurements();
      return;
    }
    if (sel.length >= 2){
      const from = startOfDay(sel[0]);
      const to   = endOfDayExclusive(sel[1]);
      window.activeDateRange = { from, to };
      wrapBtn.classList.add('active');
      document.querySelectorAll('.ranges .pill[data-preset]').forEach(b=>b.classList.remove('active'));
      setDateLabel(from, to);
      closeModal();
      loadMeasurements();
      return;
    }
    btnCancel?.click();
  });

  function cancelSelection(){
    wrapBtn.classList.remove('active');
    window.activeDateRange = null;
    resetDateLabel();
    closeModal();
    window.startPolling?.();
    loadMeasurements(); // kembali ke preset aktif
  }
  btnCancel?.addEventListener('click', cancelSelection);
  btnClose ?.addEventListener('click', cancelSelection);
  modal.addEventListener('click', (e)=>{ if (e.target === modal) cancelSelection(); });
  document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape' && modal.classList.contains('show')) cancelSelection(); });

  window.__resetDateLabel = resetDateLabel;
})();

/* =======================
   EXPORT PDF
======================= */
function setupExportPDF(){
  const btn = document.getElementById('btnExport');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const jspdfNS = window.jspdf || {};
    const jsPDF = jspdfNS.jsPDF || window.jsPDF;
    if (!jsPDF) {
      console.error('[ExportPDF] jsPDF belum termuat');
      alert('Gagal membuat PDF: jsPDF belum termuat.');
      return;
    }

    const doc = new jsPDF({ unit:'pt', format:'a4' });
    doc.setFont('helvetica','bold'); doc.setFontSize(16);
    doc.text('Tapeflow — Monitoring Report', 40, 40);
    doc.setFont('helvetica','normal'); doc.setFontSize(10);

    const deviceText = (function(){
      if (!deviceSelect || !deviceSelect.options.length) return '—';
      return deviceSelect.options[deviceSelect.selectedIndex]?.text || `Device #${deviceSelect.value}`;
    })();
    const sensorText = (function(){
      if (selectedSensor === 'all') return 'All sensors';
      const s = (sensorCache || []).find(x => String(x.id) === String(selectedSensor));
      return s ? s.name : `Sensor ${selectedSensor}`;
    })();

    let from, to, rangeLabel;
    if (activeDateRange) {
      from = activeDateRange.from; to = activeDateRange.to;
      rangeLabel = `${fmtWIB(from,true)} — ${fmtWIB(to,true)}`;
    } else {
      const r = computeRangeAnchored(); from = r.from; to = r.to;
      rangeLabel = `${fmtWIB(from,true)} — ${fmtWIB(to,true)} (${activePreset})`;
    }
    const generatedAt = fmtWIB(Date.now(), true);

    doc.text(`Device: ${deviceText}`, 40, 64);
    doc.text(`Sensor: ${sensorText}`, 40, 78);
    doc.text(`Range : ${rangeLabel}`, 40, 92);
    doc.text(`Generated: ${generatedAt}`, 40, 106);

    const canvas = document.getElementById('tempChart');
    try {
      const imgData = canvas.toDataURL('image/png', 1.0);
      const pageW = doc.internal.pageSize.getWidth();
      const imgW = Math.min(515, pageW - 80);
      const ratio = canvas.height / canvas.width;
      const imgH = imgW * ratio;
      doc.addImage(imgData, 'PNG', 40, 120, imgW, imgH);

      const startY = 120 + imgH + 24;

      const rows = [...document.querySelectorAll('#tbody tr')].slice(0,100).map(tr=>{
        const tds = tr.querySelectorAll('td');
        return [ tds[0]?.innerText ?? '', tds[1]?.innerText ?? '', tds[2]?.innerText ?? '' ];
      });

      if (rows.length) {
        if (doc.autoTable) {
          doc.autoTable({
            startY,
            head: [['#','Waktu (WIB)','Suhu (°C)']],
            body: rows,
            theme: 'grid',
            styles: { fontSize: 9, cellPadding: 3 },
            headStyles: { fillColor: [35,42,64], textColor: 255 }
          });
        } else if ((window.jspdf||{}).autoTable) {
          (window.jspdf).autoTable(doc, {
            startY,
            head: [['#','Waktu (WIB)','Suhu (°C)']],
            body: rows,
            theme: 'grid',
            styles: { fontSize: 9, cellPadding: 3 },
            headStyles: { fillColor: [35,42,64], textColor: 255 }
          });
        }
      }
    } catch(e){
      console.warn('[ExportPDF] gagal render canvas:', e);
    }

    const dev = deviceSelect?.value ?? 'device';
    const sens = selectedSensor==='all' ? 'all' : `s${selectedSensor}`;
    doc.save(`Tapeflow_${dev}_${sens}_${Date.now()}.pdf`);
  });
}

/* =======================
   INIT
======================= */
(async function init(){
  await loadDevices();

  if (deviceSelect){
    const saved = localStorage.getItem('tapeflow_device');
    if (saved) {
      selectedDevice = saved;
      deviceSelect.value = saved;
    }
    deviceSelect.addEventListener('change', async () => {
      selectedDevice = deviceSelect.value || null;
      localStorage.setItem('tapeflow_device', selectedDevice ?? '');
      await loadSensors();
      await loadMeasurements();
    });
  }

  await loadSensors();

  // tombol preset (1m/1h/1d/2d)
  document.querySelectorAll('.ranges .pill[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ranges .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activePreset = btn.dataset.preset;
      activeDateRange = null;        // keluar dari mode tanggal
      window.__resetDateLabel?.();   // reset label hh/bb/tttt
      startPolling();
      loadMeasurements();
    });
  });

  // refresh manual
  btnRefresh?.addEventListener('click', async () => {
    await loadSensors();
    await loadMeasurements();
  });

  document.querySelector(`.ranges .pill[data-preset="${activePreset}"]`)?.classList.add('active');
  await loadMeasurements();
  startPolling();
  setupExportPDF();   // aktifkan Export PDF
})();
