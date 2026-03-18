# Phase 2: Prati Dashboard — Brief from Opus to Sonnet

## Context
Phase 1 is validated. The detection engine in prati.js works: 166 tickers scanned in ~14s, correct columns, triple confirmation (Score > 15, Conc% > 40%, BP% > 80%) identifies real breakouts. EIGEN was caught live with Score 42.5, BP 98%, Conc 86% — textbook signal.

Now we wrap the engine in a dashboard. Same file (prati.js), same scan loop. We're adding a web server and an HTML frontend. Nothing changes about the detection logic.

## Architecture (Sonnet already proposed this — confirmed)
```
prati.js (single file, extends current scanner)
├── Express :3000 (or native http module — your call, keep it zero/minimal deps)
├── GET /              → inline HTML dashboard
├── GET /api/stream    → SSE endpoint (push results the moment each scan completes)
├── GET /api/klines/:symbol → full candle array from cache (for row expand)
└── Scan loop (15s wait + ~14s scan, background, unchanged)

State (in-memory, unchanged from Phase 1):
├── latestResults[]   — with miniCandles (last 30) attached per ticker
├── klineCache{}      — symbol → full sorted candles array (for expand, NO re-fetch)
└── signalAges{}      — symbol → firstSeenMs (already working)
```

## SSE, not polling
When a scan completes, push the results to the browser via Server-Sent Events. The dashboard updates the INSTANT fresh data arrives. No polling interval. No stale data sitting on screen.

## Main table columns (EXACTLY these, in this order)
```
# | Ticker | Score | Age | Vol5m% | Vol1h% | Conc% | BP% | Abn | Mini Volume Bars
```

- **#**: Rank by score
- **Ticker**: e.g. EIGENUSDT (strip "USDT" in display → "EIGEN"). Clickable → opens Bitunix futures chart in new tab
- **Score**: breakout score. Bold, white if > 20. Dim if < 5.
- **Age**: minutes since first detected (from signalAges Map). Show as "2m", "8m", etc.
  - Under 5m: full brightness + amber accent
  - 5-15m: normal
  - Over 15m: dim to 40% opacity
  - Over 30m: hide from table entirely
- **Vol5m%**: volume growth last 5 candles vs prior 5. Green if positive, red if negative.
- **Vol1h%**: volume growth last 60 candles vs prior 60. Same color logic.
- **Conc%**: concentration. What % of last 60 candles' volume happened in last 5 candles. Normal ~8%. Color: >40% amber, >60% red (hot).
- **BP%**: buy pressure. % of last 5 candles' volume that was green (close > open). Color: >80% bright green, <30% bright red, 30-80% neutral.
- **Abn**: abnormal candle count (e.g. "4/5"). Color: 5/5 red, 4/5 amber, 3/5 yellow.
- **Mini Volume Bars**: THE CRITICAL UI ELEMENT. See below.

**NO Price column. NO price-based %. This is a volume-only tool.**

Baseline, Recent, and 24hVol are NOT in the main table. They go in the expand panel.

## Mini Volume Bars (most important visual element)
For each ticker row, render the last 30 one-minute candles as tiny vertical bars:
- Bar height proportional to that candle's quoteVol (scaled to that ticker's own max)
- Green bar if candle close > open
- Red bar if candle close < open
- Bar width: 3-4px, gap: 1px
- Total width: ~135-150px
- Draw a faint dashed horizontal line at the baseline level
- Last 5 candles (the "recent" window) at full opacity
- Candles 6-30 at 30-40% opacity (faded context)
- The pattern we're looking for: flat flat flat SPIKE SPIKE SPIKE
- Ship the last 30 raw candle objects per ticker in the SSE payload: { open, close, baseVol, time }

## Click-to-expand detail panel
Clicking a row expands it below to show:

**Left side (wide):** Extended volume bar chart — full candle array from klineCache (up to 240 bars, 4 hours). Same bar style as mini chart but taller (80px height), 2px per bar. Dashed baseline line with "baseline" label. "4h ago" and "now" labels at edges.

**Right side (200px):** Stats panel:
- Baseline (4h avg): value + "per 1m candle"
- Recent avg (5 candles): value + "Xx baseline"
- Abnormal candles: X/5 + "above 3x threshold"
- Breakout score: value + "ratio × consecutive"
- "Open in Bitunix →" button linking to the futures chart

Data source: GET /api/klines/:symbol returns the cached candle array. Zero extra API calls — this data is already in memory from the scan.

## Design
- Dark theme. NOT generic. Bloomberg terminal precision meets Apple restraint.
- Background: #08080a
- Surface/rows: #111114
- Borders: #1a1a1e
- Text primary: #e5e5e5
- Text secondary: #888
- Text dim: #444
- Green: #22c55e
- Red: #ef4444
- Amber (accent, top signals): #f59e0b
- Font: -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif
- No gradients, no glows, no rounded cards, no decoration
- Top row (rank #1) gets a subtle 2px left border in amber
- Row hover: lighten background slightly
- Tabular nums (fontVariantNumeric: tabular-nums) for all numbers — columns must align
- Title in header: "प्रति Prati" with "v0.1" dimmed

## Header bar
- Left: "प्रति Prati v0.1"
- Right: green pulse dot + "Live" (changes to "Scanning..." during active scan), ticker count, scan duration

## Signal highlighting
When a ticker passes ALL THREE thresholds (Score > 15, Conc > 40%, BP > 80%), give the entire row a very subtle amber background tint (#f59e0b08). This is the "Prati says look at this NOW" signal. Don't overdo it — a hint, not a Christmas tree.

## What to keep in mind
- ALL HTML, CSS, and JS inline in prati.js as template literals. One file.
- Vanilla JS in the frontend. No React, no build tools.
- Mini volume bars as inline SVG. No charting library.
- Desktop only. Don't waste time on mobile.
- The detection engine loop is UNCHANGED. Don't touch the scoring logic, the columns, or the scan timing. Just add the server and frontend layer on top.
- Keep the console output too — it's useful for debugging. The server and console can coexist.

## Vol% timeframe selector (nice to have, not blocking)
The Vol5m% column header can have a tiny dropdown to switch between 5m/10m/15m. The data for all three is calculable from the 30 miniCandles already in the payload — frontend does the math. This is purely a display toggle, zero backend changes. If it's quick to add, do it. If it complicates things, skip it for now.
