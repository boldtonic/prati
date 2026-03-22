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
const path    = require('path');
const fs      = require('fs');

const BASE_URL          = 'https://fapi.bitunix.com';
const KLINE_LIMIT       = 200;          // Bitunix 1m kline API caps at 200
const RECENT_CANDLES    = 5;
const RATIO_THRESHOLD   = 3;
const MIN_24H_VOL_USDT  = 500_000;
const MAX_24H_VOL_USDT  = 100_000_000;
// Large-caps excluded regardless of volume — breakouts on these don't signal the same thing
const BLOCKLIST = new Set([
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOTUSDT',
  'AVAXUSDT','MATICUSDT','LINKUSDT','UNIUSDT','AAVEUSDT','LTCUSDT',
  'ATOMUSDT','NEARUSDT','APTUSDT','ARBUSDT','OPUSDT','SUIUSDT','SEIUSDT',
]);
const SCAN_INTERVAL_MS  = 15_000;
const API_DELAY_MS      = 50;
const BATCH_SIZE        = 5;
const TOP_N             = 20;
const PORT              = 3000;
const MAX_BASELINE_AVG  = 10_000;   // filter always-active tickers (>$10K USDT avg/candle)
const MAX_RECENT_SCANS  = 4;        // ring buffer depth for AI spotter
const SPOTTER_CYCLE_FREQ = 4;       // fire spotter every N scans when signals exist
const SPOTTER_MIN_SCORE = 5;        // minimum score to bother the API
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

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

async function postJson(url, body, headers = {}) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const b = await res.json(); msg = b?.error?.message || msg; } catch {}
      throw new Error(msg);
    }
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

// ─── AI prompts ───────────────────────────────────────────────────────────────

const TICKER_CHAT_SYSTEM_PROMPT = `You are Prati, a sharp trading analyst embedded in a live Bitunix futures scanner. The user is an active trader who makes their own decisions — they want analysis, not disclaimers.

ALWAYS structure your response exactly like this (no headers, just flow):

[VERDICT in caps]: one sentence explaining the key signal with specific numbers from the data.
STOP: the specific candle level or pattern that invalidates this setup (e.g. "close below 0.2540 on volume").
HORIZON: scalp (1-5m) / swing (5-30m) / avoid — pick one and say why.
CONVICTION: X/5 — one sentence on what's holding you back or what makes this strong.

Rules:
- Never say "I cannot predict" or add risk disclaimers — the user knows the risks
- Always reference actual numbers from the kline data provided
- If the last candle was a spike followed by collapse, say FADE not STRONG
- Distinguish: sustained volume ramp (accumulation) vs single spike (event/stop hunt)
- Be wrong confidently rather than hedge endlessly — the user needs a decision framework, not a weather forecast`;

const CHAT_SYSTEM_PROMPT = `You are Prati, a live trading intelligence for a Bitunix futures scanner covering 135 mid/small-cap tickers.

METRIC GUIDE:
- score = avgRatio × abnormal candle count (>15 strong, >25 exceptional)
- age = minutes since first detection (<5m fresh, >15m late, >30m ignore)
- bp = buy pressure % — what % of recent volume was buying (>80% bullish, <30% selling, 45-55% = manipulation/wash)
- conc = % of last hour's volume in last 5 minutes (baseline ~8%, >40% = something happening NOW)
- vol5m/vol1h = % growth vs prior equivalent window
- abn = candles above 3× baseline out of last 5

TRIPLE CONFIRMATION = score>15 AND conc>40 AND bp>80 simultaneously — this is the highest-conviction signal.

When klines are available: classify the volume structure as:
- ESCALATING: staircase of rising volume = sustained accumulation, best entries
- SPIKING: single massive candle then drop = event/stop hunt, often fade
- DISTRIBUTED: elevated across many candles = real move building

ALWAYS complete the trade idea when asked about a specific ticker:
1. What's happening (structure + phase)
2. Entry timing (now / wait for confirmation / avoid)
3. What invalidates the setup
4. Rough time horizon

Never hedge endlessly. Never add risk disclaimers. The user is an experienced trader who makes their own decisions.`;

const PIN_COMMENTARY_SYSTEM_PROMPT = `You are monitoring a pinned Bitunix futures ticker for a live trader. Write exactly 2 sentences:
1. Current status with specific numbers: is the breakout holding, fading, or building?
2. What to watch for: the specific level or signal that changes the picture.
No disclaimers. No hedging. Numbers only.`;

const SPOTTER_SYSTEM_PROMPT = `You are a senior quant analyst embedded in Prati, a real-time volume breakout scanner for Bitunix crypto futures. You monitor mid/small-cap futures (500K–100M USDT daily volume) where sudden volume means accumulation or distribution.

Data per ticker: Score (avgRatio × abnormalCount, >15 strong, >25 exceptional), Age (minutes since first detection, <5m fresh, >15m late), vol5m/vol1h (% volume growth vs prior equivalent window), conc (% of hour's volume in last 5min, baseline ~8%, >40% = happening now), bp (buy pressure from green candles, >80% buying, <30% selling), consecutiveAbnormal (candles above 3× baseline out of 5).

Use previous scans to classify each ticker — NEW (not in prior scans = just started), ACCELERATING (score rising = strengthening), FADING (score falling = dying), PERSISTENT (all scans = check age).

Output: 3–5 lines max. Lead with 1–2 actionable tickers or "Nothing actionable this cycle." For each: name, why it's interesting, early or late. Flag traps: high score + low bp = dumping; fading; stale age. Use ⚡ fresh, ⚠️ caution, ❌ avoid. No disclaimers, no hedging.`;

const RESEARCH_SYSTEM_PROMPT = `You are a quant researcher analyzing a specific Bitunix futures ticker from the Prati volume scanner.

You receive: current metrics, this ticker's trajectory across recent scan cycles, and the last 60 one-minute candles.

Analyze:
1. VOLUME STRUCTURE: Escalating (staircase), spiking (single candle), or distributed? Accelerating or decelerating in the most recent candles?
2. TIMING: Ignition (1–3 abnormal candles, very early) / Acceleration (growing candle-over-candle, prime entry window) / Peak (massive candle, often the top) / Distribution (elevated but decreasing, late)?
3. DIRECTION: Buy-side or sell-side dominant? Consistent or mixed? Mixed = battle, not clean breakout.
4. CONVICTION 1–5: 5 = textbook escalating buy-side early breakout. 1 = avoid.

Output format (exactly this):
Volume Structure: [1–2 sentences]
Timing: [phase] — [brief explanation]
Direction: [Buy/Sell/Mixed] — [bp analysis]
Conviction: [1–5] — [one-line justification]
Bottom line: [one sentence — what should the trader do?]`;

// ─── Data fetching ────────────────────────────────────────────────────────────

async function getEligibleTickers() {
  const data = await fetchJson(`${BASE_URL}/api/v1/futures/market/tickers`);
  if (data.code !== 0) throw new Error(`Tickers API: ${data.msg}`);
  return data.data.filter(t => {
    if (!t.symbol.endsWith('USDT')) return false;   // USDT pairs only
    if (BLOCKLIST.has(t.symbol))    return false;   // exclude large-caps
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
  if (baselineAvg > MAX_BASELINE_AVG) return null;  // skip always-active tickers

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

const signalAges      = new Map();
const klineCache      = new Map();    // symbol → sorted candle[]
const recentlyExpired = new Map();    // symbol → { symbol, expiredAt, peakScore, duration, finalBP, finalConc }
const recentScans     = [];           // ring buffer of last MAX_RECENT_SCANS snapshots
let latestResults     = [];
let latestMeta        = { scanTime: null, duration: null, eligibleCount: 0 };
let sseClients        = [];
let isScanning        = false;
let spottersActive    = false;

// ── Security helpers ─────────────────────────────────────────────────────────
const VALID_SYMBOL   = /^[A-Z0-9]{3,20}USDT$/;
const aiRateLast     = new Map();  // ip → last request ms
function checkAiRate(req, minMs = 1500) {
  const ip   = req.ip || 'local';
  const last = aiRateLast.get(ip) || 0;
  if (Date.now() - last < minMs) return false;
  aiRateLast.set(ip, Date.now());
  return true;
}
const ignitionFired   = new Map(); // symbol → last candle time that fired ignition
let scanCycleCount    = 0;
let lastAnalysis      = null;         // { text, generatedAt }
let spotterCalling    = false;
const devLog          = [];           // circular dev log, max 100 entries

// ─── Pin state ────────────────────────────────────────────────────────────────
const pinnedTickers      = new Set();   // server-side — survives page reload
const pinCommentary      = new Map();   // symbol → { text, updatedAt }
const pinLastCommentary  = new Map();   // symbol → timestamp of last API call

function log(tag, msg) {
  const entry = `[${now()}] [${tag}] ${msg}`;
  console.log(entry);
  devLog.push(entry);
  if (devLog.length > 100) devLog.shift();
}

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
    log('ERROR', `ticker fetch failed: ${e.message}`);
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
    if (!activeSymbols.has(sym)) {
      const lastKnown = latestResults.find(r => r.symbol === sym);
      if (lastKnown) {
        const duration = Math.floor((nowMs - signalAges.get(sym)) / 60_000);
        recentlyExpired.set(sym, {
          symbol: sym, expiredAt: nowMs, peakScore: lastKnown.score,
          duration, finalBP: lastKnown.bp, finalConc: lastKnown.conc,
        });
        if (recentlyExpired.size > 5) {
          const oldest = [...recentlyExpired.keys()].reduce((a, b) =>
            recentlyExpired.get(a).expiredAt < recentlyExpired.get(b).expiredAt ? a : b);
          recentlyExpired.delete(oldest);
        }
      }
      signalAges.delete(sym);
    }
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

  // Ring buffer for AI spotter context
  recentScans.unshift({
    scanTime: now(),
    results:  results.slice(0, 10).map(r => ({
      symbol: r.symbol, score: r.score, age: r.age,
      vol5m: r.vol5m, vol1h: r.vol1h, conc: r.conc, bp: r.bp,
      consecutiveAbnormal: r.consecutiveAbnormal,
    })),
  });
  if (recentScans.length > MAX_RECENT_SCANS) recentScans.pop();

  // Trigger AI spotters (non-blocking)
  scanCycleCount++;
  if (spottersActive && !spotterCalling && process.env.ANTHROPIC_API_KEY) {
    const triples   = results.filter(r => r.score > 15 && r.conc > 40 && r.bp > 80);
    const hasSignal = results.some(r => r.score > SPOTTER_MIN_SCORE);
    if (triples.length > 0 || (hasSignal && scanCycleCount % SPOTTER_CYCLE_FREQ === 0)) {
      runSpotters(triples).catch(e => console.error('Spotter error:', e.message));
    }
  }

  const duration = ((Date.now() - t0) / 1000).toFixed(1);
  log('SCAN', `done in ${duration}s — ${tickers.length} eligible, ${results.length} signals, cycle #${scanCycleCount + 1}`);
  printTable(results);

  latestResults = results;
  latestMeta    = { scanTime: now(), duration, eligibleCount: tickers.length };
  isScanning    = false;

  pushSSE({ type: 'scan', ...latestMeta, results, expired: [...recentlyExpired.values()] });

  // Update commentary for pinned tickers (non-blocking)
  for (const sym of pinnedTickers) {
    const result  = results.find(r => r.symbol === sym);
    const candles = klineCache.get(sym);
    if (result && candles) {
      updatePinCommentary(sym, result, candles).catch(e => log('PIN', `commentary error: ${e.message}`));
    }
  }
}

// ─── AI features ──────────────────────────────────────────────────────────────

async function updatePinCommentary(symbol, result, candles) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const last = pinLastCommentary.get(symbol) || 0;
  if (Date.now() - last < 2 * 60_000) return;   // max once per 2 min
  pinLastCommentary.set(symbol, Date.now());

  const trajectory = recentScans
    .map(s => s.results.find(r => r.symbol === symbol))
    .filter(Boolean)
    .map(r => ({ score: +r.score.toFixed(1), bp: r.bp, conc: +r.conc.toFixed(0) }));

  const payload = {
    symbol: symbol.replace(/USDT$/, ''),
    current: {
      score: +result.score.toFixed(1), age: result.age,
      bp: result.bp, conc: +result.conc.toFixed(0),
      vol5m: +result.vol5m.toFixed(0), abn: result.consecutiveAbnormal,
    },
    trajectory,
    candles: candles.slice(-30).map(c => ({
      vol: parseFloat(c.baseVol), close: parseFloat(c.close), open: parseFloat(c.open),
    })),
  };

  try {
    const data = await postJson(ANTHROPIC_API_URL, {
      model: 'claude-sonnet-4-6', max_tokens: 120,
      system: PIN_COMMENTARY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }, { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });
    const text = data.content[0].text;
    pinCommentary.set(symbol, { text, updatedAt: now() });
    pushSSE({ type: 'pin_commentary', symbol, text, updatedAt: now() });
    log('PIN', `${symbol}: ${text.slice(0, 80)}`);
  } catch (e) {
    log('PIN', `API error for ${symbol}: ${e.message}`);
  }
}

async function runSpotters(tripleResults) {
  spotterCalling = true;
  pushSSE({ type: 'spotter_calling' });
  log('SPOTTER', `firing — ${tripleResults.length} triples: ${tripleResults.map(r => r.symbol).join(', ') || 'none (cycle trigger)'}`);

  const prevSymbols = new Set(recentScans.slice(1).flatMap(s => s.results.map(r => r.symbol)));
  const enriched    = (recentScans[0]?.results || []).map(r => ({
    ...r,
    isNew:      !prevSymbols.has(r.symbol),
    trajectory: recentScans.slice(1)
      .map(s => s.results.find(p => p.symbol === r.symbol))
      .filter(Boolean)
      .map(p => ({ score: p.score, conc: p.conc, bp: p.bp })),
  }));

  const payload = {
    currentScan:         enriched,
    tripleConfirmations: tripleResults.map(r => ({
      symbol: r.symbol, score: r.score, bp: r.bp, conc: r.conc, age: r.age,
    })),
    scanTime: latestMeta.scanTime,
  };

  try {
    const data = await postJson(ANTHROPIC_API_URL, {
      model:      'claude-sonnet-4-6',
      max_tokens: 300,
      system:     SPOTTER_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: JSON.stringify(payload) }],
    }, {
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    });
    const text   = data.content[0].text;
    lastAnalysis = { text, generatedAt: now() };
    pushSSE({ type: 'analysis', text, generatedAt: lastAnalysis.generatedAt });
    log('SPOTTER', `response: ${text.slice(0, 120).replace(/\n/g, ' ')}${text.length > 120 ? '…' : ''}`);
  } catch (e) {
    log('ERROR', `spotter API: ${e.message}`);
    pushSSE({ type: 'analysis', text: `⚠️ Analysis failed: ${e.message}`, generatedAt: now() });
  } finally {
    spotterCalling = false;
    pushSSE({ type: 'spotter_status', active: spottersActive, calling: false });
  }
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────────

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Prati — Volume Breakout Scanner</title>
  <style>
    :root {
      --bg:      #080b12;
      --surface: #0d1117;
      --raised:  #111827;
      --hover:   #161d2b;
      --sel:     #0f1a2e;
      --bs:      #1e2d45;
      --b:       #131e2e;
      --bd:      #0e1623;
      --t1:      #e2e8f0;
      --t2:      #64748b;
      --t3:      #334155;
      --green:   #22c55e;
      --red:     #ef4444;
      --amber:   #f59e0b;
      --purple:  #818cf8;
      --cyan:    #38bdf8;
      --mono:    'SF Mono','Cascadia Code','Fira Code','JetBrains Mono',ui-monospace,monospace;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--t1);
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      font-size: 13px;
      min-height: 100vh;
    }

    /* ── Header ───────────────────────────────────── */
    #header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 0 20px; height: 44px;
      background: var(--raised); border-bottom: 1px solid var(--bs);
      position: sticky; top: 0; z-index: 10;
    }
    .h-left  { display: flex; align-items: center; gap: 14px; }
    .h-right { display: flex; align-items: center; gap: 20px; }
    .brand { font-size: 15px; font-weight: 600; color: var(--purple); letter-spacing: -0.02em; }
    .brand-ver { font-size: 10px; font-weight: 400; color: var(--t3); margin-left: 5px; }
    .h-sep { width: 1px; height: 16px; background: var(--bs); }
    .h-meta { font-size: 11px; color: var(--t2); font-family: var(--mono); }
    .h-meta .v { color: var(--t1); }

    /* Status pill */
    .spill {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 10px 3px 7px; border-radius: 20px;
      font-size: 11px; font-weight: 500;
      background: var(--surface); border: 1px solid var(--bs); color: var(--t2);
      transition: border-color 0.3s, color 0.3s;
    }
    .spill.live     { border-color: rgba(34,197,94,0.4);   color: #22c55e; }
    .spill.scanning { border-color: rgba(245,158,11,0.4);  color: #f59e0b; }
    .spill.dead     { border-color: rgba(239,68,68,0.3);   color: #ef4444; }
    .sdot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    .live .sdot     { animation: alv 2.5s ease-in-out infinite; }
    .scanning .sdot { animation: asc 0.8s ease-in-out infinite; }
    @keyframes alv { 0%,100%{opacity:1} 50%{opacity:0.3} }
    @keyframes asc { 0%,100%{opacity:1} 50%{opacity:0.2} }

    /* ── Table ────────────────────────────────────── */
    #main-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    #main-table thead th {
      padding: 8px 12px; color: var(--t2);
      font-size: 10px; font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.07em;
      text-align: right; border-bottom: 1px solid var(--bs);
      background: var(--raised); white-space: nowrap; user-select: none;
    }
    #main-table thead th.left { text-align: left; }
    #main-table td {
      padding: 0 12px; height: 38px;
      border-bottom: 1px solid var(--b);
      font-family: var(--mono); font-variant-numeric: tabular-nums;
      font-size: 12px; text-align: right;
      white-space: nowrap; overflow: hidden; vertical-align: middle;
    }
    #main-table td.left { text-align: left; }
    tr.data-row { cursor: pointer; }
    tr.data-row:hover td { background: var(--hover); }
    tr.data-row.is-expanded td { background: var(--sel); }
    tr.expand-row td { background: var(--sel); padding: 0; border-bottom: 2px solid var(--bs); }

    /* Score badges */
    .sb {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 46px; padding: 2px 7px; border-radius: 4px;
      font-size: 12.5px; font-weight: 700; font-family: var(--mono);
      font-variant-numeric: tabular-nums; border: 1px solid transparent;
    }
    .sb-crit { background: rgba(129,140,248,0.18); border-color: rgba(129,140,248,0.45); color: #a5b4fc; }
    .sb-high { background: rgba(129,140,248,0.09); border-color: rgba(129,140,248,0.25); color: #818cf8; }
    .sb-mid  { background: rgba(245,158,11,0.08);  border-color: rgba(245,158,11,0.22);  color: #f59e0b; }
    .sb-low  { color: var(--t3); border-color: var(--bd); }

    /* ── Expand panel ─────────────────────────────── */
    .expand-inner { display: flex; flex-direction: column; }
    .expand-chart { padding: 16px 20px 12px; }
    .chart-labels {
      display: flex; justify-content: space-between;
      font-size: 10px; color: var(--t3);
      font-family: var(--mono); margin-bottom: 6px;
    }
    .exp-svg { display: block; width: 100%; }

    .expand-stats {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr 1.4fr auto;
      background: var(--bg);
      gap: 1px;
      border-top: 1px solid var(--bs);
    }
    .sc {
      background: var(--raised);
      padding: 14px 16px;
    }
    .sc-label {
      font-size: 10px; font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.07em;
      color: var(--t2); margin-bottom: 6px;
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    }
    .sc-val {
      font-family: var(--mono); font-size: 22px; font-weight: 600;
      color: var(--t1); font-variant-numeric: tabular-nums; line-height: 1;
    }
    .sc-sub {
      font-size: 11px; color: var(--t3); margin-top: 4px;
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    }
    .sc-score .sc-val { font-size: 32px; font-weight: 700; }
    .btn-open {
      display: flex; align-items: center; justify-content: center;
      gap: 6px; padding: 0 20px; min-width: 110px;
      background: var(--raised); border: none;
      border-left: 1px solid var(--bg);
      color: var(--cyan); font-size: 12px; font-weight: 500;
      text-decoration: none; white-space: nowrap;
    }
    .btn-open:hover { background: var(--hover); }

    .vol-select {
      background: transparent; border: none;
      color: var(--t2); font-size: 10px; font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.07em;
      cursor: pointer; outline: none;
    }
    .vol-select option { background: var(--raised); color: var(--t1); }
    .empty-msg { text-align: center !important; padding: 80px !important; color: var(--t2); font-family: var(--mono); }

    /* ── Analysis Panel ───────────────────────── */
    #analysis-panel {
      display: flex; align-items: flex-start; gap: 16px;
      padding: 10px 20px; background: var(--raised);
      border-bottom: 1px solid var(--bs); min-height: 44px;
    }
    #analysis-text {
      flex: 1; font-size: 12px; line-height: 1.65; color: var(--t3);
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      white-space: pre-line; align-self: center;
    }
    #analysis-text.has-content { color: var(--t1); }
    .analysis-meta {
      display: flex; flex-direction: column; align-items: flex-end;
      gap: 6px; flex-shrink: 0;
    }
    #analysis-time { font-size: 10px; color: var(--t3); font-family: var(--mono); }
    .spotter-btn {
      padding: 5px 12px; border-radius: 4px; font-size: 11px; font-weight: 500;
      cursor: pointer; border: 1px solid var(--bs); background: var(--surface);
      color: var(--t2); transition: border-color 0.2s, color 0.2s; white-space: nowrap;
    }
    .spotter-btn:hover { border-color: var(--cyan); color: var(--cyan); }
    .spotter-btn.active { border-color: rgba(34,197,94,0.5); color: var(--green); }
    .spotter-btn.calling { border-color: rgba(245,158,11,0.4); color: var(--amber); }

    /* ── Faded Section ────────────────────────── */
    #faded-section { display: none; }
    .faded-header {
      padding: 10px 20px 4px; font-size: 10px; font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.07em; color: var(--t3);
    }
    .faded-row {
      display: flex; align-items: center; gap: 20px; padding: 5px 20px;
      opacity: 0.4; font-family: var(--mono); font-size: 11px; color: var(--t2);
      border-bottom: 1px solid var(--b);
    }
    .faded-row:hover { opacity: 0.65; }
    .faded-sym  { min-width: 70px; font-weight: 500; color: var(--t2); }
    .faded-score { min-width: 70px; }
    .faded-dur  { min-width: 40px; color: var(--t3); }
    .faded-bp   { min-width: 50px; }

    /* ── Research panel ───────────────────────── */
    .expand-research {
      padding: 12px 16px; background: var(--raised);
      border-top: 1px solid var(--bs);
    }
    .btn-research {
      padding: 5px 12px; border-radius: 4px; font-size: 11px; font-weight: 500;
      cursor: pointer; border: 1px solid var(--bs); background: var(--surface);
      color: var(--cyan); transition: border-color 0.15s;
    }
    .btn-research:hover:not(:disabled) { border-color: var(--cyan); }
    .btn-research:disabled { opacity: 0.45; cursor: default; }
    .research-output { margin-top: 12px; }
    .research-text {
      font-size: 12px; line-height: 1.7; color: var(--t1); white-space: pre-line;
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    }
    .research-time { font-size: 10px; color: var(--t3); margin-top: 6px; font-family: var(--mono); }
  </style>
</head>
<body>

<div id="header">
  <div class="h-left">
    <div class="brand">&#x092A;&#x094D;&#x0930;&#x0924;&#x093F; Prati<span class="brand-ver">v0.1</span></div>
    <div class="h-sep"></div>
    <div class="spill" id="spill">
      <span class="sdot"></span>
      <span id="status-label">Connecting&hellip;</span>
    </div>
  </div>
  <div class="h-right">
    <span class="h-meta" id="eligible"></span>
    <span class="h-meta" id="duration"></span>
    <span id="scan-time" style="font-size:10px;color:var(--t3);font-family:var(--mono);"></span>
    <button onclick="toggleDevLog()" style="padding:3px 9px;border-radius:4px;font-size:10px;font-weight:500;cursor:pointer;border:1px solid var(--bs);background:var(--surface);color:var(--t3);font-family:var(--mono);">dev</button>
  </div>
</div>

<div id="dev-panel" style="display:none;position:fixed;bottom:0;left:0;right:0;height:280px;background:#050810;border-top:1px solid #1e2d45;z-index:100;flex-direction:column;">
  <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 16px;border-bottom:1px solid #1e2d45;">
    <span style="font-size:10px;font-weight:500;color:#334155;font-family:monospace;text-transform:uppercase;letter-spacing:.06em;">Dev Log</span>
    <div style="display:flex;gap:10px;">
      <button onclick="window.copyLog()" style="padding:2px 8px;border-radius:3px;font-size:10px;cursor:pointer;border:1px solid #1e2d45;background:#0d1117;color:#64748b;">Copy</button>
      <button onclick="window.toggleDevLog()" style="padding:2px 8px;border-radius:3px;font-size:10px;cursor:pointer;border:1px solid #1e2d45;background:#0d1117;color:#64748b;">Close</button>
    </div>
  </div>
  <pre id="dev-log-content" style="flex:1;overflow-y:auto;margin:0;padding:10px 16px;font-size:11px;line-height:1.6;color:#64748b;font-family:monospace;white-space:pre-wrap;word-break:break-all;"></pre>
</div>

<div id="analysis-panel">
  <div id="analysis-text">Spotters inactive. Click Start to enable AI analysis.</div>
  <div class="analysis-meta">
    <span id="analysis-time"></span>
    <button class="spotter-btn" id="spotter-btn" onclick="toggleSpotters()">Start Spotters</button>
  </div>
</div>

<table id="main-table">
  <colgroup>
    <col style="width:44px">
    <col style="width:110px">
    <col style="width:88px">
    <col style="width:52px">
    <col style="width:96px">
    <col style="width:82px">
    <col style="width:72px">
    <col style="width:62px">
    <col style="width:54px">
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

<div id="faded-section">
  <div class="faded-header">Recently Faded</div>
  <div id="faded-list"></div>
</div>

<script>
(function () {
  var currentData    = null;
  var expandedSymbol = null;
  var volPeriod      = 5;
  var lastScanAt     = null;
  var knownTriples   = new Set();
  var analysisAt     = null;

  // Live "Scanned Xs ago" counter
  setInterval(function () {
    if (!lastScanAt) return;
    var s = Math.floor((Date.now() - lastScanAt) / 1000);
    document.getElementById('scan-time').textContent = 'Scanned ' + s + 's ago';
  }, 1000);

  // Live "Analysis: Xs ago" counter
  setInterval(function () {
    if (!analysisAt) return;
    var s = Math.floor((Date.now() - analysisAt) / 1000);
    var el = document.getElementById('analysis-time');
    if (el) el.textContent = 'Analysis: ' + s + 's ago';
  }, 5000);

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
        lastScanAt  = Date.now();
        setStatus('live');
        document.getElementById('eligible').innerHTML = '<span class="v">' + data.eligibleCount + '</span> tickers';
        document.getElementById('duration').innerHTML = '<span class="v">' + data.duration + 's</span>';
        renderTable(data.results);
        renderFaded(data.expired || []);
        checkTripleNotifications(data.results);
      } else if (data.type === 'analysis') {
        setAnalysis(data.text);
      } else if (data.type === 'spotter_status') {
        setSpotterStatus(data.active, data.calling || false);
      } else if (data.type === 'spotter_calling') {
        setSpotterStatus(true, true);
      }
    } catch (_) {}
  };

  es.onerror = function () { setStatus('dead'); };

  function setStatus(s) {
    var pill  = document.getElementById('spill');
    var label = document.getElementById('status-label');
    pill.className = 'spill';
    if (s === 'live')          { pill.classList.add('live');     label.textContent = 'Live'; }
    else if (s === 'scanning') { pill.classList.add('scanning'); label.textContent = 'Scanning\u2026'; }
    else                       { pill.classList.add('dead');     label.textContent = 'Disconnected'; }
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

  function scoreBadge(score) {
    var cls = score > 25 ? 'sb sb-crit' : score > 15 ? 'sb sb-high' : score >= 5 ? 'sb sb-mid' : 'sb sb-low';
    return '<span class="' + cls + '">' + score.toFixed(1) + '</span>';
  }

  function renderRow(r, i) {
    var triple  = r.score > 15 && r.conc > 40 && r.bp > 80;
    var rowBg   = triple ? 'background:rgba(245,158,11,0.05);' : '';
    var leftBdr = (i === 0 || triple)
      ? 'border-left:2px solid #f59e0b;'
      : 'border-left:2px solid transparent;';

    var ageText  = r.age === 0 ? '<1m' : r.age + 'm';
    var ageStyle = r.age < 5  ? 'color:#f59e0b;font-weight:600;'
                 : r.age > 15 ? 'opacity:0.35;'
                 : '';

    var vol      = calcVolPct(r.miniCandles, volPeriod);
    // Only fall back to backend value when period matches; otherwise show — to avoid mislabelling
    if (vol === null && volPeriod === 5) vol = r.vol5m;
    var volStyle = vol === null ? 'color:#334155;' : vol >= 0 ? 'color:#22c55e;' : 'color:#ef4444;';

    var vol1hStyle = r.vol1h >= 0 ? 'color:#22c55e;' : 'color:#ef4444;';

    var concStyle = r.conc > 60 ? 'color:#ef4444;font-weight:600;'
                  : r.conc > 40 ? 'color:#f59e0b;font-weight:600;'
                  : 'color:#334155;';

    var bpStyle = r.bp > 80 ? 'color:#22c55e;font-weight:600;'
                : r.bp < 30 ? 'color:#ef4444;font-weight:600;'
                : 'color:#334155;';

    var abnStyle = r.consecutiveAbnormal >= 5 ? 'color:#ef4444;font-weight:700;'
                 : r.consecutiveAbnormal >= 4 ? 'color:#f59e0b;'
                 : r.consecutiveAbnormal >= 3 ? 'color:#fde68a;'
                 : 'color:#334155;';

    var sym        = r.symbol.replace(/USDT$/, '');
    var bitunixUrl = 'https://www.bitunix.com/es-es/contract-trade/' + r.symbol;
    var miniSvg    = (r.miniCandles && r.miniCandles.length > 0)
                     ? buildMiniSvg(r.miniCandles, r.baselineAvg) : '';

    return '<tr class="data-row" data-symbol="' + r.symbol + '" style="' + rowBg + leftBdr + '">' +
      '<td style="color:#334155;font-size:11px;">' + (i + 1) + '</td>' +
      '<td class="left"><a href="' + bitunixUrl + '" target="_blank" onclick="event.stopPropagation()" ' +
        'style="color:#38bdf8;text-decoration:none;font-weight:500;">' + sym + '</a></td>' +
      '<td>' + scoreBadge(r.score) + '</td>' +
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

    var bW = 4, bG = 1, h = 52;
    var totalW = candles.length * (bW + bG) - bG;
    var baseH  = Math.min(h - 1, Math.max(1, (baselineAvg / maxVol) * h));
    var baseY  = (h - baseH).toFixed(1);

    var parts = [
      '<svg width="' + totalW + '" height="' + h + '" style="display:block;vertical-align:middle">',
      '<line x1="0" y1="' + baseY + '" x2="' + totalW + '" y2="' + baseY +
        '" stroke="#1e3a5f" stroke-dasharray="2,3" stroke-width="1"/>'
    ];

    for (var i = 0; i < candles.length; i++) {
      var c    = candles[i];
      var x    = i * (bW + bG);
      var bH   = Math.max(2, (c.baseVol / maxVol) * h);
      var y    = (h - bH).toFixed(1);
      var isR  = i >= candles.length - 5;
      var fill = c.close >= c.open ? '#22c55e' : '#ef4444';
      parts.push('<rect x="' + x + '" y="' + y + '" width="' + bW + '" height="' + bH.toFixed(1) +
        '" fill="' + fill + '" opacity="' + (isR ? '1' : '0.22') + '"/>');
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
      '<div style="padding:24px 20px;color:#64748b;font-size:12px;font-family:var(--mono);">Loading\u2026</div>' +
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
        if (inner) inner.innerHTML = '<div style="padding:24px 20px;color:#ef4444;font-size:12px;">Failed to load klines</div>';
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
    if (!result) { inner.innerHTML = '<div style="padding:20px;color:#64748b;font-size:12px;">Data not found</div>'; return; }

    var maxVol = 0;
    for (var i = 0; i < candles.length; i++) {
      var v = parseFloat(candles[i].baseVol);
      if (v > maxVol) maxVol = v;
    }

    // Responsive SVG via viewBox — fills full container width, no empty space
    var bW = 3, bH = 100;
    var totalViewW = candles.length * (bW + 1) - 1;
    var baseViewH  = maxVol > 0 ? Math.min(bH - 1, Math.max(1, (result.baselineAvg / maxVol) * bH)) : 1;
    var baseViewY  = (bH - baseViewH).toFixed(1);

    var bars = [
      '<svg viewBox="0 0 ' + totalViewW + ' ' + bH + '" preserveAspectRatio="none" class="exp-svg" style="height:100px">',
      '<line x1="0" y1="' + baseViewY + '" x2="' + totalViewW + '" y2="' + baseViewY +
        '" stroke="#1e3a5f" stroke-dasharray="4,3" stroke-width="1" vector-effect="non-scaling-stroke"/>'
    ];

    for (var i = 0; i < candles.length; i++) {
      var c    = candles[i];
      var vol  = parseFloat(c.baseVol);
      var x    = i * (bW + 1);
      var barH = maxVol > 0 ? Math.max(1, (vol / maxVol) * bH) : 1;
      var y    = (bH - barH).toFixed(1);
      var isR  = i >= candles.length - 5;
      var fill = parseFloat(c.close) >= parseFloat(c.open) ? '#22c55e' : '#ef4444';
      bars.push('<rect x="' + x + '" y="' + y + '" width="' + bW + '" height="' + barH.toFixed(1) +
        '" fill="' + fill + '" opacity="' + (isR ? '1' : '0.28') + '"/>');
    }
    bars.push('</svg>');

    var bitunixUrl = 'https://www.bitunix.com/es-es/contract-trade/' + symbol;
    var sym        = symbol.replace(/USDT$/, '');

    var scoreColor = result.score > 25 ? '#a5b4fc'
                   : result.score > 15 ? '#818cf8'
                   : result.score >= 5 ? '#f59e0b'
                   : '#334155';
    var abnColor   = result.consecutiveAbnormal >= 5 ? '#ef4444'
                   : result.consecutiveAbnormal >= 4 ? '#f59e0b'
                   : '#e2e8f0';

    inner.innerHTML =
      '<div class="expand-chart">' +
        '<div class="chart-labels"><span>4h ago</span><span>baseline \u2014\u2014</span><span>now</span></div>' +
        bars.join('') +
      '</div>' +
      '<div class="expand-stats">' +
        '<div class="sc">' +
          '<div class="sc-label">Baseline (4h avg)</div>' +
          '<div class="sc-val">' + fmtVol(result.baselineAvg) + '</div>' +
          '<div class="sc-sub">per 1m candle</div>' +
        '</div>' +
        '<div class="sc">' +
          '<div class="sc-label">Recent avg (5 candles)</div>' +
          '<div class="sc-val">' + fmtVol(result.recentAvg) + '</div>' +
          '<div class="sc-sub">' + result.avgRatio.toFixed(1) + '\u00d7 baseline</div>' +
        '</div>' +
        '<div class="sc">' +
          '<div class="sc-label">Abnormal candles</div>' +
          '<div class="sc-val" style="color:' + abnColor + '">' + result.consecutiveAbnormal + '/5</div>' +
          '<div class="sc-sub">above 3\u00d7 threshold</div>' +
        '</div>' +
        '<div class="sc sc-score">' +
          '<div class="sc-label">Breakout score</div>' +
          '<div class="sc-val" style="color:' + scoreColor + '">' + result.score.toFixed(1) + '</div>' +
          '<div class="sc-sub">ratio \u00d7 consecutive</div>' +
        '</div>' +
        '<a class="btn-open" href="' + bitunixUrl + '" target="_blank">' +
          sym + ' \u2192' +
        '</a>' +
      '</div>' +
      '<div class="expand-research">' +
        '<button class="btn-research" id="rbtn-' + symbol + '" onclick="triggerResearch(\\x27' + symbol + '\\x27)">' +
          '🔬 Deep Analysis' +
        '</button>' +
        '<div class="research-output" id="rout-' + symbol + '" style="display:none"></div>' +
      '</div>';
  }

  // ── Utilities ─────────────────────────────────────────────────────────────
  function calcVolPct(candles, period) {
    if (!candles || candles.length < period * 2) return null;
    var last = 0, prior = 0, n = candles.length;
    for (var i = n - period; i < n; i++)               last  += candles[i].baseVol;
    for (var i = n - period * 2; i < n - period; i++)  prior += candles[i].baseVol;
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

  // ── Spotter controls ──────────────────────────────────────────────────────
  function toggleSpotters() {
    fetch('/api/spotters/toggle', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { alert(d.error); return; }
        setSpotterStatus(d.active, false);
        if (d.active && 'Notification' in window && Notification.permission === 'default') {
          Notification.requestPermission();
        }
      })
      .catch(function () { alert('Could not reach server'); });
  }

  function setSpotterStatus(active, calling) {
    var btn = document.getElementById('spotter-btn');
    btn.className = 'spotter-btn' + (calling ? ' calling' : active ? ' active' : '');
    btn.textContent = calling ? 'Analyzing\u2026' : active ? 'Stop Spotters' : 'Start Spotters';
    var txt = document.getElementById('analysis-text');
    if (!active && !calling && !txt.classList.contains('has-content')) {
      txt.textContent = 'Spotters inactive. Click Start to enable AI analysis.';
    }
    if (active && !calling && !txt.classList.contains('has-content')) {
      txt.textContent = 'Spotters active \u2014 waiting for signals\u2026';
    }
  }

  function setAnalysis(text) {
    var txt = document.getElementById('analysis-text');
    txt.textContent = text;
    txt.classList.add('has-content');
    analysisAt = Date.now();
    document.getElementById('analysis-time').textContent = 'Analysis: just now';
  }

  // ── Recently faded ────────────────────────────────────────────────────────
  function renderFaded(expired) {
    var section = document.getElementById('faded-section');
    if (!expired || expired.length === 0) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    document.getElementById('faded-list').innerHTML = expired.map(function (e) {
      var bpStyle = e.finalBP > 60 ? 'color:#22c55e' : e.finalBP < 30 ? 'color:#ef4444' : '';
      var sym     = e.symbol.replace(/USDT$/, '');
      return '<div class="faded-row">' +
        '<span class="faded-sym">' + sym + '</span>' +
        '<span class="faded-score">Score ' + e.peakScore.toFixed(1) + '</span>' +
        '<span class="faded-dur">' + e.duration + 'm</span>' +
        '<span class="faded-bp" style="' + bpStyle + '">BP ' + e.finalBP + '%</span>' +
        '</div>';
    }).join('');
  }

  // ── Browser notifications ─────────────────────────────────────────────────
  function checkTripleNotifications(results) {
    if (!results) return;
    var currentTriples = new Set();
    results.forEach(function (r) {
      if (r.score > 15 && r.conc > 40 && r.bp > 80) {
        currentTriples.add(r.symbol);
        if (!knownTriples.has(r.symbol)) fireNotification(r);
      }
    });
    knownTriples = currentTriples;
  }

  function fireNotification(r) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification('\u26a1 ' + r.symbol.replace(/USDT$/, '') + ' \u2014 Triple Confirmation', {
      body: 'Score ' + r.score.toFixed(1) + ' \u00b7 BP ' + r.bp + '% \u00b7 Conc ' + r.conc.toFixed(0) + '%',
      tag:  r.symbol,
    });
  }

  // ── AI Research ───────────────────────────────────────────────────────────
  // ── Dev log ───────────────────────────────────────────────────────────────
  var devPanelOpen = false;
  function toggleDevLog() {
    devPanelOpen = !devPanelOpen;
    var panel = document.getElementById('dev-panel');
    panel.style.display = devPanelOpen ? 'flex' : 'none';
    if (devPanelOpen) refreshLog();
  }
  function refreshLog() {
    fetch('/api/log')
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var el = document.getElementById('dev-log-content');
        el.textContent = t || '(no log entries yet)';
      });
  }
  function copyLog() {
    fetch('/api/log')
      .then(function (r) { return r.text(); })
      .then(function (t) { navigator.clipboard.writeText(t); });
  }

  // Expose to global scope for onclick handlers
  window.toggleDevLog   = toggleDevLog;
  window.copyLog        = copyLog;
  window.toggleSpotters = toggleSpotters;
  window.triggerResearch = triggerResearch;

  function triggerResearch(symbol) {
    var btn = document.getElementById('rbtn-' + symbol);
    var out = document.getElementById('rout-' + symbol);
    if (!btn || !out) return;
    btn.textContent = 'Analyzing\u2026';
    btn.disabled = true;
    out.style.display = 'none';
    var ctrl  = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 35000);
    fetch('/api/research/' + symbol, { method: 'POST', signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); return r.json(); })
      .then(function (d) {
        if (d.error) {
          out.innerHTML = '<span style="color:#ef4444">Error: ' + d.error + '</span>';
        } else {
          out.innerHTML = '<div class="research-text">' + d.text.replace(/\n/g, '<br>') + '</div>' +
            '<div class="research-time">' + d.generatedAt + '</div>';
        }
        out.style.display = 'block';
        btn.textContent = '🔬 Re-analyze';
        btn.disabled = false;
      })
      .catch(function () {
        clearTimeout(timer);
        out.innerHTML = '<span style="color:#ef4444">Request failed or timed out</span>';
        out.style.display = 'block';
        btn.textContent = '🔬 Deep Analysis';
        btn.disabled = false;
      });
  }
}());
</script>

</body>
</html>`;
}

// ─── Fast ignition check ──────────────────────────────────────────────────────

function runIgnitionCheck() {
  if (!latestResults.length) return;

  for (const result of latestResults) {
    const sym     = result.symbol;
    const candles = klineCache.get(sym);
    if (!candles || !candles.length) continue;

    const last     = candles[candles.length - 1];
    const baseline = result.baselineAvg;
    if (!baseline || baseline <= 0) continue;

    const ratio = last.baseVol / baseline;
    if (ratio < 4) continue;

    // Deduplicate — only fire once per candle timestamp
    if (ignitionFired.get(sym) === last.time) continue;
    ignitionFired.set(sym, last.time);

    const short = sym.replace(/USDT$/, '');
    log('IGN', `${short} candle spike ${ratio.toFixed(1)}× baseline`);
    pushSSE({
      type:     'ignition',
      symbol:   sym,
      ratio:    +ratio.toFixed(1),
      vol:      last.baseVol,
      baseline: +baseline.toFixed(0),
      candle:   { open: last.open, close: last.close, time: last.time },
      score:    result.score,
      bp:       result.bp,
      age:      result.age,
    });
  }
}

// ─── Web server ───────────────────────────────────────────────────────────────

function startServer() {
  const app = express();
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'dashboard.html'));
  });

  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send current state immediately on connect
    if (latestResults.length > 0) {
      res.write(`data: ${JSON.stringify({ type: 'scan', ...latestMeta, results: latestResults, expired: [...recentlyExpired.values()] })}\n\n`);
    }
    if (isScanning) {
      res.write(`data: ${JSON.stringify({ type: 'scanning' })}\n\n`);
    }
    // Send pin state + any existing commentary
    res.write(`data: ${JSON.stringify({ type: 'pins', pins: [...pinnedTickers] })}\n\n`);
    for (const [sym, c] of pinCommentary) {
      res.write(`data: ${JSON.stringify({ type: 'pin_commentary', symbol: sym, ...c })}\n\n`);
    }

    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
  });

  // ── Pin management ──────────────────────────────────────────────────────────
  app.get('/api/pins', (_req, res) => {
    const pins = [...pinnedTickers].map(sym => ({
      symbol:     sym,
      data:       latestResults.find(r => r.symbol === sym) || null,
      commentary: pinCommentary.get(sym) || null,
    }));
    res.json(pins);
  });

  app.post('/api/pins/:symbol', (req, res) => {
    if (!VALID_SYMBOL.test(req.params.symbol)) return res.status(400).json({ error: 'Invalid symbol' });
    pinnedTickers.add(req.params.symbol);
    pushSSE({ type: 'pins', pins: [...pinnedTickers] });
    log('PIN', `pinned ${req.params.symbol}`);
    res.json({ pinned: true, symbol: req.params.symbol });
  });

  app.delete('/api/pins/:symbol', (req, res) => {
    if (!VALID_SYMBOL.test(req.params.symbol)) return res.status(400).json({ error: 'Invalid symbol' });
    pinnedTickers.delete(req.params.symbol);
    pinCommentary.delete(req.params.symbol);
    pinLastCommentary.delete(req.params.symbol);
    pushSSE({ type: 'pins', pins: [...pinnedTickers] });
    log('PIN', `unpinned ${req.params.symbol}`);
    res.json({ pinned: false, symbol: req.params.symbol });
  });

  // ── Chat ─────────────────────────────────────────────────────────────────────
  app.post('/api/chat', async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set — add it to START.command' });
    }
    if (!checkAiRate(req, 1500)) return res.status(429).json({ error: 'Too fast — wait a moment' });
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });

    // Scan summary (top 15, compact)
    const signals = latestResults.slice(0, 15).map(r => ({
      sym:   r.symbol.replace(/USDT$/, ''),
      score: +r.score.toFixed(1),
      age:   r.age,
      bp:    r.bp,
      conc:  +r.conc.toFixed(0),
      vol5m: +r.vol5m.toFixed(0),
      abn:   r.consecutiveAbnormal,
      triple: r.score > 15 && r.conc > 40 && r.bp > 80,
    }));

    // Detect mentioned tickers
    const upper     = message.toUpperCase();
    const mentioned = [];
    for (const sym of klineCache.keys()) {
      const short = sym.replace(/USDT$/, '');
      if (short.length >= 3 && upper.includes(short)) mentioned.push(sym);
    }

    // Build kline + trajectory context for mentioned tickers
    const klines = {};
    const trajectory = {};
    for (const sym of mentioned) {
      const short = sym.replace(/USDT$/, '');
      const cached = klineCache.get(sym);
      if (cached) {
        klines[short] = cached.slice(-60).map(c => ({
          time: c.time, open: c.open, close: c.close, vol: c.baseVol,
        }));
      }
      const traj = recentScans
        .map(s => s.results.find(r => r.symbol === sym))
        .filter(Boolean)
        .map(r => ({ score: +r.score.toFixed(1), bp: r.bp, conc: +r.conc.toFixed(0) }));
      if (traj.length) trajectory[short] = traj;
    }

    const context = {
      scanTime: latestMeta.scanTime,
      pinned:   [...pinnedTickers].map(s => s.replace(/USDT$/, '')),
      signals,
      ...(Object.keys(klines).length      && { klines }),
      ...(Object.keys(trajectory).length  && { trajectory }),
    };

    // Ensure history alternates correctly (must start with user)
    let hist = (history || []).slice(-8);
    if (hist.length && hist[0].role !== 'user') hist = hist.slice(1);

    const messages = [
      ...hist,
      { role: 'user', content: `Context:\n${JSON.stringify(context)}\n\nQuestion: ${message}` },
    ];

    try {
      const data = await postJson(ANTHROPIC_API_URL, {
        model: 'claude-sonnet-4-6', max_tokens: 400,
        system: CHAT_SYSTEM_PROMPT,
        messages,
      }, { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });
      res.json({ text: data.content[0].text, at: now() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/ticker-chat', async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'No API key' });
    if (!checkAiRate(req, 1000)) return res.status(429).json({ error: 'Too fast — wait a moment' });
    const { symbol, message, history } = req.body;
    if (!symbol || !message) return res.status(400).json({ error: 'Missing symbol or message' });
    if (!VALID_SYMBOL.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });

    const result  = latestResults.find(r => r.symbol === symbol);
    const candles = klineCache.get(symbol);
    const traj    = recentScans
      .map(s => s.results && s.results.find(r => r.symbol === symbol))
      .filter(Boolean)
      .map(r => ({ score: +r.score.toFixed(1), bp: r.bp, conc: +r.conc.toFixed(0) }));

    const context = {
      symbol:   symbol.replace(/USDT$/, ''),
      scanTime: latestMeta.scanTime,
      ...(result && {
        score: +result.score.toFixed(1), bp: result.bp,
        conc:  +result.conc.toFixed(0),  vol5m: +result.vol5m.toFixed(0),
        vol1h: +result.vol1h.toFixed(0), abn: result.consecutiveAbnormal,
        age:   result.age,
      }),
      ...(candles && { klines: candles.slice(-60).map(c => ({ time: c.time, open: c.open, close: c.close, vol: c.baseVol })) }),
      ...(traj.length && { trajectory: traj }),
    };

    let hist = (history || []).slice(-6);
    if (hist.length && hist[0].role !== 'user') hist = hist.slice(1);

    const messages = [
      ...hist,
      { role: 'user', content: `Context:\n${JSON.stringify(context)}\n\nQuestion: ${message}` },
    ];

    try {
      const data = await postJson(ANTHROPIC_API_URL, {
        model: 'claude-sonnet-4-6', max_tokens: 400,
        system: TICKER_CHAT_SYSTEM_PROMPT,
        messages,
      }, { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });
      res.json({ text: data.content[0].text, at: now() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/klines/:symbol', (req, res) => {
    if (!VALID_SYMBOL.test(req.params.symbol)) return res.status(400).json({ error: 'Invalid symbol' });
    const candles = klineCache.get(req.params.symbol);
    if (!candles) return res.status(404).json({ error: 'not in cache' });
    res.json(candles);
  });

  app.get('/api/log', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(devLog.slice().reverse().join('\n'));
  });

  app.post('/api/spotters/toggle', (_req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });
    }
    spottersActive = !spottersActive;
    if (!spottersActive) spotterCalling = false;
    pushSSE({ type: 'spotter_status', active: spottersActive, calling: false });
    res.json({ active: spottersActive });
  });

  app.post('/api/research/:symbol', async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });
    }
    const symbol  = req.params.symbol;
    const candles = klineCache.get(symbol);
    if (!candles) return res.status(404).json({ error: 'not in cache' });
    const current = latestResults.find(r => r.symbol === symbol);
    if (!current)  return res.status(404).json({ error: 'not in current results' });

    const trajectory = recentScans
      .map(s => s.results.find(r => r.symbol === symbol))
      .filter(Boolean)
      .map(r => ({ score: r.score, conc: r.conc, bp: r.bp, age: r.age }));

    const payload = {
      ticker: symbol,
      currentMetrics: {
        score: current.score, age: current.age, vol5m: current.vol5m,
        vol1h: current.vol1h, conc: current.conc, bp: current.bp,
        consecutiveAbnormal: current.consecutiveAbnormal,
        baselineAvg: current.baselineAvg, recentAvg: current.recentAvg,
      },
      trajectory,
      candles: candles.slice(-60).map(c => ({
        time: c.time, open: c.open, close: c.close, baseVol: c.baseVol,
      })),
    };

    try {
      const data = await postJson(ANTHROPIC_API_URL, {
        model:      'claude-sonnet-4-6',
        max_tokens: 500,
        system:     RESEARCH_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: JSON.stringify(payload) }],
      }, {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      });
      res.json({ text: data.content[0].text, generatedAt: now() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`Dashboard: http://localhost:${PORT}`);
  });

  // Fast ignition check — runs every 8s, pure in-memory
  setInterval(runIgnitionCheck, 8_000);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('⚠  ANTHROPIC_API_KEY not set — AI features (Spotters, Research) disabled');
  } else {
    console.log('✓  Anthropic API key detected — AI features enabled');
  }
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
