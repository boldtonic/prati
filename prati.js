#!/usr/bin/env node
/**
 * Prati — Bitunix Volume Breakout Scanner (Phase 1: Console)
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

const BASE_URL = 'https://fapi.bitunix.com';

const KLINE_LIMIT       = 245;          // 240 baseline + 5 recent + a few spare
const RECENT_CANDLES    = 5;            // candles to check for breakout
const RATIO_THRESHOLD   = 3;            // 3x baseline = abnormal
const MIN_24H_VOL_USDT  = 500_000;      // filter out dead tickers
const MAX_24H_VOL_USDT  = 100_000_000;  // filter out BTC/ETH noise
const SCAN_INTERVAL_MS  = 60_000;       // rescan every 60s
const API_DELAY_MS      = 150;          // delay between kline calls (rate limit)
const TOP_N             = 20;           // rows to display

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function formatVol(v) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

function formatChange(c) {
  return `${c >= 0 ? '+' : ''}${c.toFixed(1)}%`;
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function getEligibleTickers() {
  const data = await fetchJson(`${BASE_URL}/api/v1/futures/market/tickers`);
  if (data.code !== 0) throw new Error(`Tickers API: ${data.msg}`);

  return data.data.filter(t => {
    const vol = parseFloat(t.quoteVol || 0); // quoteVol = USDT on this endpoint
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

  // Sort oldest → newest
  const sorted = [...klines].sort((a, b) => parseInt(a.time) - parseInt(b.time));

  const recent   = sorted.slice(-RECENT_CANDLES);
  const baseline = sorted.slice(0, -RECENT_CANDLES);

  // On kline endpoint: baseVol = USDT volume (reversed from tickers endpoint)
  const baselineAvg = baseline.reduce((s, c) => s + parseFloat(c.baseVol), 0) / baseline.length;
  if (baselineAvg === 0) return null;

  const recentVols = recent.map(c => parseFloat(c.baseVol));
  const recentAvg  = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const ratios     = recentVols.map(v => v / baselineAvg);

  const consecutiveAbnormal = ratios.filter(r => r >= RATIO_THRESHOLD).length;
  const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const score    = avgRatio * consecutiveAbnormal;

  // 1h price change
  const currentClose  = parseFloat(sorted.at(-1).close);
  const hourAgoClose  = parseFloat(sorted[Math.max(0, sorted.length - 61)].close);
  const change1h      = hourAgoClose > 0 ? ((currentClose - hourAgoClose) / hourAgoClose) * 100 : 0;

  return { score, avgRatio, consecutiveAbnormal, baselineAvg, recentAvg, currentClose, change1h };
}

// ─── Display ──────────────────────────────────────────────────────────────────

function printTable(results) {
  const cols = [
    { label: ' #',    width: 3,  align: 'r' },
    { label: 'Ticker', width: 14, align: 'l' },
    { label: 'Price',  width: 10, align: 'r' },
    { label: '1h%',    width: 7,  align: 'r' },
    { label: 'Score',  width: 7,  align: 'r' },
    { label: 'Ratio',  width: 7,  align: 'r' },
    { label: 'Abnorm', width: 8,  align: 'r' },
    { label: 'Baseline', width: 10, align: 'r' },
    { label: 'Recent',  width: 10,  align: 'r' },
  ];

  const pad = (str, width, align) =>
    align === 'r' ? String(str).padStart(width) : String(str).padEnd(width);

  const header = cols.map(c => pad(c.label, c.width, c.align)).join(' │ ');
  const divider = cols.map(c => '─'.repeat(c.width)).join('─┼─');

  console.log(header);
  console.log(divider);

  const top = results.slice(0, TOP_N);
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const row = [
      pad(i + 1,                         cols[0].width, cols[0].align),
      pad(r.symbol,                      cols[1].width, cols[1].align),
      pad(r.currentClose.toFixed(4),     cols[2].width, cols[2].align),
      pad(formatChange(r.change1h),      cols[3].width, cols[3].align),
      pad(r.score.toFixed(1),            cols[4].width, cols[4].align),
      pad(`${r.avgRatio.toFixed(1)}x`,   cols[5].width, cols[5].align),
      pad(`${r.consecutiveAbnormal}/5`,  cols[6].width, cols[6].align),
      pad(formatVol(r.baselineAvg),      cols[7].width, cols[7].align),
      pad(formatVol(r.recentAvg),        cols[8].width, cols[8].align),
    ].join(' │ ');
    console.log(row);
  }

  if (results.length === 0) console.log('  (no breakouts detected this cycle)');
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function scan() {
  const t0 = Date.now();
  console.log('\n════════════════════════════════════════════════');
  console.log(' PRATI — BITUNIX VOLUME BREAKOUT SCANNER');
  console.log(`════════════════════════════════════════════════`);
  console.log(`Scan time: ${now()}`);

  let tickers;
  try {
    tickers = await getEligibleTickers();
  } catch (e) {
    console.error(`Ticker fetch failed: ${e.message}`);
    return;
  }

  console.log(`Eligible tickers: ${tickers.length} | Scanning...`);

  const results = [];

  for (const ticker of tickers) {
    try {
      const klines   = await getKlines(ticker.symbol);
      const breakout = calcBreakout(klines);
      if (breakout && breakout.score > 0) {
        results.push({ symbol: ticker.symbol, ...breakout });
      }
    } catch (_) {
      // skip failed tickers silently
    }
    await sleep(API_DELAY_MS);
  }

  results.sort((a, b) => b.score - a.score);

  const duration = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Duration: ${duration}s | Results: ${results.length} tickers with score > 0\n`);

  printTable(results);
}

async function main() {
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
