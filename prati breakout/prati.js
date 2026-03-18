#!/usr/bin/env node
/**
 * Prati — Bitunix Volume Breakout Scanner (Phase 2: Dashboard)
 *
 * Detection logic:
 *   BASELINE = avg USDT volume per 1-min candle over last 240 candles (skip 5 most recent)
 *   RECENT   = last 5 candles
 *   SCORE    = avg_ratio × count(ratio > 3x) across recent candles
 *
 * NOTE: Bitunix API field naming is inconsistent between endpoints:
 *   /tickers klines: baseVol = USDT volume, quoteVol = token count
 *   /tickers:        quoteVol = USDT volume, baseVol = token count
 */

const express = require('express');

const BASE_URL          = 'https://fapi.bitunix.com';
const KLINE_LIMIT       = 200;          // Bitunix 1m kline API caps at 200
const RECENT_CANDLES    = 5;
const RATIO_THRESHOLD   = 3;
const MIN_24H_VOL_USDT  = 500_000;
const MAX_24H_VOL_USDT  = 100_000_000;
const SCAN_INTERVAL_MS  = 15_000;
const API_DELAY_MS      = 50;
const BATCH_SIZE        = 5;
const TOP_N             = 20;
const PORT              = 3000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

function formatVol(v) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

function formatVolPct(v) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`;
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function getEligibleTickers() {
  const data = await fetchJson(`${BASE_URL}/api/v1/futures/market/tickers`);
  if (data.code !== 0) throw new Error(`Tickers API: ${data.msg}`);
  return data.data.filter(t => {
    const vol = parseFloat(t.quoteVol || 0);
    return vol >= MIN_24H_VOL_USDT && vol <= MAX_24H_VOL_USDT;
  });
}

async function getKlines(symbol) {
  const url = `${BASE_URL}/api/v1/futures/market/kline?symbol=${symbol}&interval=1m&limit=${KLINE_LIMIT}`;
  const data = await fetchJson(url);
  if (data.code !== 0) return null;
  return data.data;
}

// ─── Detection ────────────────────────────────────────────────────────────────

function calcBreakout(klines) {
  if (!klines || klines.length < RECENT_CANDLES + 10) return null;

  const sorted   = [...klines].sort((a, b) => parseInt(a.time) - parseInt(b.time));
  const recent   = sorted.slice(-RECENT_CANDLES);
  const baseline = sorted.slice(0, -RECENT_CANDLES);

  // ⚠ FIELD SWAP: on /kline endpoint, baseVol = USDT volume, quoteVol = token count
  const baselineAvg = baseline.reduce((s, c) => s + parseFloat(c.baseVol), 0) / baseline.length;
  if (baselineAvg === 0) return null;

  const recentVols          = recent.map(c => parseFloat(c.baseVol));
  const recentAvg           = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const ratios              = recentVols.map(v => v / baselineAvg);
  const consecutiveAbnormal = ratios.filter(r => r >= RATIO_THRESHOLD).length;
  const avgRatio            = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const score               = avgRatio * consecutiveAbnormal;

  // recentVols already holds the last RECENT_CANDLES baseVol values — reuse instead of re-slicing
  const vol5mLast  = recentVols.reduce((a, b) => a + b, 0);
  const vol5mPrior = sorted.slice(-10, -5).reduce((s, c) => s + parseFloat(c.baseVol), 0);
  const vol5m      = vol5mPrior > 0 ? (vol5mLast / vol5mPrior - 1) * 100 : 0;

  const vol1hLast  = sorted.slice(-60).reduce((s, c) => s + parseFloat(c.baseVol), 0);
  const vol1hPrior = sorted.slice(-120, -60).reduce((s, c) => s + parseFloat(c.baseVol), 0);
  const vol1h      = vol1hPrior > 0 ? (vol1hLast / vol1hPrior - 1) * 100 : 0;

  const conc = vol1hLast > 0 ? (vol5mLast / vol1hLast) * 100 : 0;

  // reuse `recent` (same as sorted.slice(-RECENT_CANDLES)) and vol5mLast (same total)
  const greenVol = recent.filter(c => parseFloat(c.close) > parseFloat(c.open))
                         .reduce((sum, c) => sum + parseFloat(c.baseVol), 0);
  const bp       = vol5mLast > 0 ? Math.round((greenVol / vol5mLast) * 100) : 50;

  const currentClose = parseFloat(sorted.at(-1).close);
  return { score, avgRatio, consecutiveAbnormal, baselineAvg, recentAvg, currentClose, vol5m, vol1h, conc, bp };
}

// ─── Console display ──────────────────────────────────────────────────────────

function printTable(results) {
  const cols = [
    { label: ' #',       width: 3,  align: 'r' },
    { label: 'Ticker',   width: 14, align: 'l' },
    { label: 'Score',    width: 7,  align: 'r' },
    { label: 'Age',      width: 5,  align: 'r' },
    { label: 'Vol5m%',   width: 9,  align: 'r' },
    { label: 'Vol1h%',   width: 9,  align: 'r' },
    { label: 'Conc%',    width: 7,  align: 'r' },
    { label: 'BP%',      width: 5,  align: 'r' },
    { label: 'Abn',      width: 5,  align: 'r' },
    { label: 'Baseline', width: 10, align: 'r' },
    { label: 'Recent',   width: 10, align: 'r' },
    { label: '24hVol',   width: 9,  align: 'r' },
  ];

  const pad = (str, width, align) =>
    align === 'r' ? String(str).padStart(width) : String(str).padEnd(width);

  console.log(cols.map(c => pad(c.label, c.width, c.align)).join(' │ '));
  console.log(cols.map(c => '─'.repeat(c.width)).join('─┼─'));

  const top = results.slice(0, TOP_N);
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    console.log([
      pad(i + 1,                                    cols[0].width,  cols[0].align),
      pad(r.symbol,                                 cols[1].width,  cols[1].align),
      pad(r.score.toFixed(1),                       cols[2].width,  cols[2].align),
      pad(r.age === 0 ? '<1m' : `${r.age}m`,        cols[3].width,  cols[3].align),
      pad(formatVolPct(r.vol5m),                    cols[4].width,  cols[4].align),
      pad(formatVolPct(r.vol1h),                    cols[5].width,  cols[5].align),
      pad(`${r.conc.toFixed(0)}%`,                  cols[6].width,  cols[6].align),
      pad(`${r.bp}%`,                               cols[7].width,  cols[7].align),
      pad(`${r.consecutiveAbnormal}/5`,             cols[8].width,  cols[8].align),
      pad(formatVol(r.baselineAvg),                 cols[9].width,  cols[9].align),
      pad(formatVol(r.recentAvg),                   cols[10].width, cols[10].align),
      pad(formatVol(r.vol24h),                      cols[11].width, cols[11].align),
    ].join(' │ '));
  }

  if (results.length === 0) console.log('  (no breakouts detected this cycle)');
}

// ─── State ────────────────────────────────────────────────────────────────────

const signalAges  = new Map();
const klineCache  = new Map();   // symbol → sorted candle[]
let latestResults = [];
let latestMeta    = { scanTime: null, duration: null, eligibleCount: 0 };
let sseClients    = [];
let isScanning    = false;

// ─── SSE ──────────────────────────────────────────────────────────────────────

function pushSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(payload); return true; }
    catch (_) { return false; }
  });
}

// ─── Scan loop ────────────────────────────────────────────────────────────────

async function scan() {
  const t0 = Date.now();
  console.log('\n════════════════════════════════════════════════');
  console.log(' PRATI — BITUNIX VOLUME BREAKOUT SCANNER');
  console.log('════════════════════════════════════════════════');
  console.log(`Scan time: ${now()}`);

  isScanning = true;
  pushSSE({ type: 'scanning' });

  let tickers;
  try {
    tickers = await getEligibleTickers();
  } catch (e) {
    console.error(`Ticker fetch failed: ${e.message}`);
    isScanning = false;
    return;
  }

  console.log(`Eligible: ${tickers.length} tickers (filter: ${formatVol(MIN_24H_VOL_USDT)}–${formatVol(MAX_24H_VOL_USDT)} USDT 24h)`);

  const results = [];

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async ticker => {
      try {
        const klines = await getKlines(ticker.symbol);
        if (klines) {
          const sorted = [...klines].sort((a, b) => parseInt(a.time) - parseInt(b.time));
          klineCache.set(ticker.symbol, sorted);
        }
        const breakout = calcBreakout(klines);
        if (breakout && breakout.score > 0) {
          return { symbol: ticker.symbol, vol24h: parseFloat(ticker.quoteVol || 0), ...breakout };
        }
      } catch (_) {}
      return null;
    }));
    results.push(...batchResults.filter(Boolean));
    if (i + BATCH_SIZE < tickers.length) await sleep(API_DELAY_MS);
  }

  results.sort((a, b) => b.score - a.score);

  // Signal age tracking
  const nowMs         = Date.now();
  const activeSymbols = new Set(results.map(r => r.symbol));
  for (const r of results) {
    if (!signalAges.has(r.symbol)) signalAges.set(r.symbol, nowMs);
    r.age = Math.floor((nowMs - signalAges.get(r.symbol)) / 60_000);
  }
  for (const sym of signalAges.keys()) {
    if (!activeSymbols.has(sym)) signalAges.delete(sym);
  }

  // Attach last 30 candles per ticker for the mini bars
  for (const r of results) {
    const cached = klineCache.get(r.symbol);
    r.miniCandles = cached
      ? cached.slice(-30).map(c => ({
          open:    parseFloat(c.open),
          close:   parseFloat(c.close),
          baseVol: parseFloat(c.baseVol),
          time:    parseInt(c.time),
        }))
      : [];
  }

  const duration = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Duration: ${duration}s | Results: ${results.length} tickers with score > 0\n`);
  printTable(results);

  latestResults = results;
  latestMeta    = { scanTime: now(), duration, eligibleCount: tickers.length };
  isScanning    = false;

  pushSSE({ type: 'scan', ...latestMeta, results });
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────────

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Prati — Volume Breakout Scanner</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #08080a;
      color: #e5e5e5;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif;
      font-size: 13px;
      min-height: 100vh;
    }
    #header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 20px;
      border-bottom: 1px solid #1a1a1e;
      background: #08080a;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .title   { font-size: 16px; font-weight: 600; letter-spacing: -0.02em; }
    .version { color: #444; font-size: 12px; margin-left: 8px; }
    .header-meta { display: flex; gap: 16px; align-items: center; font-size: 12px; color: #888; }
    .status-group { display: flex; gap: 6px; align-items: center; }
    .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
    .dot-green { background: #22c55e; animation: pg 2s ease-in-out infinite; }
    .dot-amber { background: #f59e0b; animation: pa 0.7s ease-in-out infinite; }
    .dot-red   { background: #ef4444; }
    @keyframes pg { 0%,100%{opacity:1} 50%{opacity:0.4} }
    @keyframes pa { 0%,100%{opacity:1} 50%{opacity:0.3} }

    #main-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    #main-table thead th {
      padding: 10px 12px 8px;
      color: #555;
      font-weight: 500;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      text-align: right;
      border-bottom: 1px solid #1a1a1e;
      white-space: nowrap;
      user-select: none;
    }
    #main-table thead th.left { text-align: left; }
    #main-table td {
      padding: 6px 12px;
      border-bottom: 1px solid #0f0f12;
      font-variant-numeric: tabular-nums;
      text-align: right;
      white-space: nowrap;
      overflow: hidden;
    }
    #main-table td.left { text-align: left; }
    tr.data-row { cursor: pointer; }
    tr.data-row:hover td { background: rgba(255,255,255,0.018); }
    tr.data-row.is-expanded td { background: #0d0d10; }
    tr.expand-row td { background: #0a0a0d; padding: 0; border: none; }

    .expand-inner {
      padding: 16px 20px;
      display: flex;
      gap: 24px;
      border-bottom: 1px solid #1a1a1e;
    }
    .chart-area { flex: 1; overflow-x: auto; min-width: 0; }
    .chart-labels {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: #444;
      margin-bottom: 5px;
    }
    .stats-panel { width: 200px; flex-shrink: 0; font-size: 12px; }
    .stat-item  { margin-bottom: 14px; }
    .stat-label { color: #555; margin-bottom: 2px; font-size: 11px; }
    .stat-value { color: #e5e5e5; font-size: 15px; font-variant-numeric: tabular-nums; font-weight: 500; }
    .stat-sub   { color: #444; font-size: 11px; }
    .expand-score { color: #e5e5e5; font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .btn-open {
      display: block;
      padding: 8px 14px;
      background: #1a1a1e;
      color: #e5e5e5;
      text-decoration: none;
      font-size: 12px;
      text-align: center;
      margin-top: 4px;
    }
    .btn-open:hover { background: #222228; }

    .vol-select {
      background: transparent;
      border: none;
      color: #555;
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      outline: none;
    }
    .vol-select option { background: #1a1a1e; color: #e5e5e5; }
    .empty-msg { text-align: center !important; padding: 60px !important; color: #333; }
  </style>
</head>
<body>

<div id="header">
  <div>
    <span class="title">&#x092A;&#x094D;&#x0930;&#x0924;&#x093F; Prati</span>
    <span class="version">v0.1</span>
  </div>
  <div class="header-meta">
    <div class="status-group">
      <span class="dot dot-red" id="status-dot"></span>
      <span id="status-label">Connecting&hellip;</span>
    </div>
    <span id="eligible" style="color:#666;"></span>
    <span id="duration" style="color:#666;"></span>
    <span id="scan-time" style="color:#444;font-size:11px;"></span>
  </div>
</div>

<table id="main-table">
  <colgroup>
    <col style="width:40px">
    <col style="width:110px">
    <col style="width:68px">
    <col style="width:52px">
    <col style="width:90px">
    <col style="width:80px">
    <col style="width:72px">
    <col style="width:60px">
    <col style="width:52px">
    <col>
  </colgroup>
  <thead>
    <tr>
      <th>#</th>
      <th class="left">Ticker</th>
      <th>Score</th>
      <th>Age</th>
      <th><select class="vol-select" id="vol-select">
        <option value="5">Vol5m%</option>
        <option value="10">Vol10m%</option>
        <option value="15">Vol15m%</option>
      </select></th>
      <th>Vol1h%</th>
      <th>Conc%</th>
      <th>BP%</th>
      <th>Abn</th>
      <th class="left">Volume</th>
    </tr>
  </thead>
  <tbody id="tbody">
    <tr><td colspan="10" class="empty-msg">Waiting for first scan&hellip;</td></tr>
  </tbody>
</table>

<script>
(function () {
  var currentData    = null;
  var expandedSymbol = null;
  var volPeriod      = 5;

  // Vol period selector
  var volSelect = document.getElementById('vol-select');
  volSelect.addEventListener('change', function (e) {
    e.stopPropagation();
    volPeriod = parseInt(this.value, 10);
    if (currentData) renderTable(currentData.results);
  });
  volSelect.addEventListener('click', function (e) { e.stopPropagation(); });

  // ── SSE ──────────────────────────────────────────────────────────────────
  var es = new EventSource('/api/stream');

  es.onmessage = function (e) {
    try {
      var data = JSON.parse(e.data);
      if (data.type === 'scanning') {
        setStatus('scanning');
      } else if (data.type === 'scan') {
        currentData = data;
        setStatus('live');
        document.getElementById('eligible').textContent  = data.eligibleCount + ' tickers';
        document.getElementById('duration').textContent  = data.duration + 's';
        document.getElementById('scan-time').textContent = data.scanTime;
        renderTable(data.results);
      }
    } catch (_) {}
  };

  es.onerror = function () { setStatus('disconnected'); };

  function setStatus(s) {
    var dot   = document.getElementById('status-dot');
    var label = document.getElementById('status-label');
    if (s === 'live')         { dot.className = 'dot dot-green'; label.textContent = 'Live'; }
    else if (s === 'scanning') { dot.className = 'dot dot-amber'; label.textContent = 'Scanning\u2026'; }
    else                       { dot.className = 'dot dot-red';   label.textContent = 'Disconnected'; }
  }

  // ── Table rendering ───────────────────────────────────────────────────────
  function renderTable(results) {
    var tbody    = document.getElementById('tbody');
    var filtered = results.filter(function (r) { return r.age < 30; });

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-msg">No breakouts detected this cycle</td></tr>';
      expandedSymbol  = null;
      return;
    }

    var savedExpanded = expandedSymbol;
    tbody.innerHTML   = filtered.map(function (r, i) { return renderRow(r, i); }).join('');

    tbody.querySelectorAll('tr.data-row').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var sym = tr.dataset.symbol;
        if (expandedSymbol === sym) { collapseRow(); }
        else { expandRow(sym); }
      });
    });

    if (savedExpanded) {
      var row = tbody.querySelector('[data-symbol="' + savedExpanded + '"]');
      if (row) { expandedSymbol = null; expandRow(savedExpanded); }
      else     { expandedSymbol = null; }
    }
  }

  function renderRow(r, i) {
    var triple  = r.score > 15 && r.conc > 40 && r.bp > 80;
    var rowBg   = triple ? 'background:rgba(245,158,11,0.03);' : '';
    var leftBdr = i === 0 ? 'border-left:2px solid #f59e0b;' : 'border-left:2px solid transparent;';

    var scoreStyle = r.score > 20 ? 'font-weight:700;color:#e5e5e5;'
                   : r.score < 5  ? 'color:#444;'
                   : '';

    var ageText  = r.age === 0 ? '<1m' : r.age + 'm';
    var ageStyle = r.age < 5   ? 'color:#f59e0b;font-weight:600;'
                 : r.age > 15  ? 'opacity:0.4;'
                 : '';

    var vol      = calcVolPct(r.miniCandles, volPeriod);
    // Only fall back to backend value when period matches; otherwise show — to avoid mislabelling
    if (vol === null && volPeriod === 5) vol = r.vol5m;
    var volStyle = vol === null ? 'color:#555;' : vol >= 0 ? 'color:#22c55e;' : 'color:#ef4444;';

    var vol1hStyle = r.vol1h >= 0 ? 'color:#22c55e;' : 'color:#ef4444;';

    var concStyle = r.conc > 60 ? 'color:#ef4444;font-weight:600;'
                  : r.conc > 40 ? 'color:#f59e0b;font-weight:600;'
                  : 'color:#888;';

    var bpStyle = r.bp > 80  ? 'color:#22c55e;font-weight:600;'
                : r.bp < 30  ? 'color:#ef4444;font-weight:600;'
                : 'color:#888;';

    var abnStyle = r.consecutiveAbnormal >= 5 ? 'color:#ef4444;font-weight:700;'
                 : r.consecutiveAbnormal >= 4 ? 'color:#f59e0b;'
                 : r.consecutiveAbnormal >= 3 ? 'color:#eab308;'
                 : 'color:#555;';

    var sym        = r.symbol.replace(/USDT$/, '');
    var bitunixUrl = 'https://www.bitunix.com/es-es/futures-trade/' + r.symbol;
    var miniSvg    = (r.miniCandles && r.miniCandles.length > 0)
                     ? buildMiniSvg(r.miniCandles, r.baselineAvg) : '';

    return '<tr class="data-row" data-symbol="' + r.symbol + '" style="' + rowBg + leftBdr + '">' +
      '<td style="color:#555;">' + (i + 1) + '</td>' +
      '<td class="left"><a href="' + bitunixUrl + '" target="_blank" onclick="event.stopPropagation()" ' +
        'style="color:#e5e5e5;text-decoration:none;font-weight:500;">' + sym + '</a></td>' +
      '<td style="' + scoreStyle + '">' + r.score.toFixed(1) + '</td>' +
      '<td style="' + ageStyle + '">' + ageText + '</td>' +
      '<td style="' + volStyle + '">' + (vol === null ? '\u2014' : fmtPct(vol)) + '</td>' +
      '<td style="' + vol1hStyle + '">' + fmtPct(r.vol1h) + '</td>' +
      '<td style="' + concStyle + '">' + r.conc.toFixed(0) + '%</td>' +
      '<td style="' + bpStyle + '">' + r.bp + '%</td>' +
      '<td style="' + abnStyle + '">' + r.consecutiveAbnormal + '/5</td>' +
      '<td class="left">' + miniSvg + '</td>' +
      '</tr>';
  }

  // ── Mini SVG bars ─────────────────────────────────────────────────────────
  function buildMiniSvg(candles, baselineAvg) {
    var maxVol = 0;
    for (var i = 0; i < candles.length; i++) {
      if (candles[i].baseVol > maxVol) maxVol = candles[i].baseVol;
    }
    if (maxVol === 0) return '';

    var bW = 3, bG = 1, h = 36;
    var totalW = candles.length * (bW + bG) - bG;
    var baseH  = Math.min(h - 1, Math.max(1, (baselineAvg / maxVol) * h));
    var baseY  = (h - baseH).toFixed(1);

    var parts = [
      '<svg width="' + totalW + '" height="' + h + '" style="display:block;vertical-align:middle">',
      '<line x1="0" y1="' + baseY + '" x2="' + totalW + '" y2="' + baseY +
        '" stroke="#2a2a2e" stroke-dasharray="3,2" stroke-width="1"/>'
    ];

    for (var i = 0; i < candles.length; i++) {
      var c    = candles[i];
      var x    = i * (bW + bG);
      var bH   = Math.max(1, (c.baseVol / maxVol) * h);
      var y    = (h - bH).toFixed(1);
      var isR  = i >= candles.length - 5;
      var fill = c.close >= c.open ? '#22c55e' : '#ef4444';
      parts.push('<rect x="' + x + '" y="' + y + '" width="' + bW + '" height="' + bH.toFixed(1) +
        '" fill="' + fill + '" opacity="' + (isR ? '1' : '0.28') + '"/>');
    }

    parts.push('</svg>');
    return parts.join('');
  }

  // ── Expand / collapse ─────────────────────────────────────────────────────
  function expandRow(symbol) {
    collapseRow();
    expandedSymbol = symbol;

    var tbody = document.getElementById('tbody');
    var row   = tbody.querySelector('[data-symbol="' + symbol + '"]');
    if (!row) { expandedSymbol = null; return; }

    row.classList.add('is-expanded');

    var expTr = document.createElement('tr');
    expTr.className = 'expand-row';
    expTr.id        = 'expand-row';
    expTr.innerHTML = '<td colspan="10"><div class="expand-inner">' +
      '<div style="flex:1;color:#444;font-size:12px;">Loading\u2026</div>' +
      '</div></td>';
    row.insertAdjacentElement('afterend', expTr);

    var ctrl       = new AbortController();
    var fetchTimer = setTimeout(function () { ctrl.abort(); }, 5000);
    fetch('/api/klines/' + symbol, { signal: ctrl.signal })
      .then(function (r) { clearTimeout(fetchTimer); return r.json(); })
      .then(function (candles) { renderExpandPanel(symbol, candles); })
      .catch(function () {
        clearTimeout(fetchTimer);
        var inner = document.querySelector('#expand-row .expand-inner');
        if (inner) inner.innerHTML = '<div style="color:#ef4444;font-size:12px;">Failed to load klines</div>';
      });
  }

  function collapseRow() {
    var expRow = document.getElementById('expand-row');
    if (expRow) expRow.remove();
    if (expandedSymbol) {
      var tbody = document.getElementById('tbody');
      var row   = tbody.querySelector('[data-symbol="' + expandedSymbol + '"]');
      if (row) row.classList.remove('is-expanded');
    }
    expandedSymbol = null;
  }

  function renderExpandPanel(symbol, candles) {
    var inner = document.querySelector('#expand-row .expand-inner');
    if (!inner) return;

    var result = currentData && currentData.results.find(function (r) { return r.symbol === symbol; });
    if (!result) { inner.innerHTML = '<div style="color:#444;font-size:12px;">Data not found</div>'; return; }

    var maxVol = 0;
    for (var i = 0; i < candles.length; i++) {
      var v = parseFloat(candles[i].baseVol);
      if (v > maxVol) maxVol = v;
    }

    var bW = 2, bG = 1, bH = 80;
    var totalW = candles.length * (bW + bG) - bG;
    var baseH  = maxVol > 0 ? Math.min(bH - 1, Math.max(1, (result.baselineAvg / maxVol) * bH)) : 1;
    var baseY  = (bH - baseH).toFixed(1);

    var bars = [
      '<svg width="' + totalW + '" height="' + bH + '" style="display:block">',
      '<line x1="0" y1="' + baseY + '" x2="' + totalW + '" y2="' + baseY +
        '" stroke="#2a2a2e" stroke-dasharray="3,2" stroke-width="1"/>'
    ];

    for (var i = 0; i < candles.length; i++) {
      var c    = candles[i];
      var vol  = parseFloat(c.baseVol);
      var x    = i * (bW + bG);
      var barH = maxVol > 0 ? Math.max(1, (vol / maxVol) * bH) : 1;
      var y    = (bH - barH).toFixed(1);
      var isR  = i >= candles.length - 5;
      var fill = parseFloat(c.close) >= parseFloat(c.open) ? '#22c55e' : '#ef4444';
      bars.push('<rect x="' + x + '" y="' + y + '" width="' + bW + '" height="' + barH.toFixed(1) +
        '" fill="' + fill + '" opacity="' + (isR ? '1' : '0.35') + '"/>');
    }
    bars.push('</svg>');

    var bitunixUrl = 'https://www.bitunix.com/es-es/futures-trade/' + symbol;

    inner.innerHTML =
      '<div class="chart-area">' +
        '<div class="chart-labels"><span>4h ago</span><span>baseline \u2014\u2014</span><span>now</span></div>' +
        bars.join('') +
      '</div>' +
      '<div class="stats-panel">' +
        '<div class="stat-item">' +
          '<div class="stat-label">Baseline (4h avg)</div>' +
          '<div class="stat-value">' + fmtVol(result.baselineAvg) + '</div>' +
          '<div class="stat-sub">per 1m candle</div>' +
        '</div>' +
        '<div class="stat-item">' +
          '<div class="stat-label">Recent avg (5 candles)</div>' +
          '<div class="stat-value">' + fmtVol(result.recentAvg) + '</div>' +
          '<div class="stat-sub">' + result.avgRatio.toFixed(1) + 'x baseline</div>' +
        '</div>' +
        '<div class="stat-item">' +
          '<div class="stat-label">Abnormal candles</div>' +
          '<div class="stat-value">' + result.consecutiveAbnormal + '/5</div>' +
          '<div class="stat-sub">above 3\u00d7 threshold</div>' +
        '</div>' +
        '<div class="stat-item">' +
          '<div class="stat-label">Breakout score</div>' +
          '<div class="expand-score">' + result.score.toFixed(1) + '</div>' +
          '<div class="stat-sub">ratio \u00d7 consecutive</div>' +
        '</div>' +
        '<a class="btn-open" href="' + bitunixUrl + '" target="_blank">Open in Bitunix \u2192</a>' +
      '</div>';
  }

  // ── Utilities ─────────────────────────────────────────────────────────────
  function calcVolPct(candles, period) {
    if (!candles || candles.length < period * 2) return null;
    var last = 0, prior = 0, n = candles.length;
    for (var i = n - period; i < n; i++)           last  += candles[i].baseVol;
    for (var i = n - period * 2; i < n - period; i++) prior += candles[i].baseVol;
    return prior > 0 ? (last / prior - 1) * 100 : 0;
  }

  function fmtPct(v) {
    var capped = Math.min(9999, Math.max(-999, v));
    return (capped >= 0 ? '+' : '') + capped.toFixed(0) + '%';
  }

  function fmtVol(v) {
    if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
    if (v >= 1000)    return (v / 1000).toFixed(1) + 'K';
    return v.toFixed(0);
  }
}());
</script>

</body>
</html>`;
}

// ─── Web server ───────────────────────────────────────────────────────────────

function startServer() {
  const app = express();

  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(getDashboardHTML());
  });

  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send current state immediately on connect
    if (latestResults.length > 0) {
      res.write(`data: ${JSON.stringify({ type: 'scan', ...latestMeta, results: latestResults })}\n\n`);
    }
    if (isScanning) {
      res.write(`data: ${JSON.stringify({ type: 'scanning' })}\n\n`);
    }

    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
  });

  app.get('/api/klines/:symbol', (req, res) => {
    const candles = klineCache.get(req.params.symbol);
    if (!candles) return res.status(404).json({ error: 'not in cache' });
    res.json(candles);
  });

  app.listen(PORT, () => {
    console.log(`Dashboard: http://localhost:${PORT}`);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  startServer();
  while (true) {
    try {
      await scan();
    } catch (e) {
      console.error(`Scan error: ${e.message}`);
    }
    console.log(`\nNext scan in ${SCAN_INTERVAL_MS / 1000}s...`);
    await sleep(SCAN_INTERVAL_MS);
  }
}

main();
