# Prati

**Self-hosted BYOK AI trading assistant for Bitunix perpetual futures.**

[![License: MIT](https://img.shields.io/badge/license-MIT-gold?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-18%2B-green?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-8b5cf6?style=flat-square)]()
[![BYOK](https://img.shields.io/badge/BYOK-bring%20your%20own%20keys-f59e0b?style=flat-square)]()

Prati is a local AI command center for perpetual traders. It watches Bitunix mid/small-cap USDT perps, turns public market data into live breakout signals, and feeds that context into specialized Claude agents that help you decide what is building, what is fading, what deserves a deeper look, and what to avoid.

Ask it things like:

- "Should I long or short EIGENUSDT right now?"
- "Is this volume real or a stop hunt?"
- "What is the strongest setup on the board?"
- "Give me the entry, invalidation, horizon, and conviction."
- "Watch this pinned ticker and tell me if the picture changes."

No hosted backend. No bundled API keys. No exchange API credentials. No order execution.

---

## What you get

- **AI trading desk** - direct chat with scanner-aware context, recent candles, top signals, pinned tickers, and trajectory
- **Ticker analyst** - per-symbol chat that answers with verdict, stop/invalidation, horizon, and conviction
- **Research agent** - one-click deep dive on volume structure, timing phase, direction, and bottom line
- **Background spotter** - whole-board AI triage for fresh, accelerating, fading, persistent, or trap-like setups
- **Pinned monitors** - pin tickers and get auto-refreshing 2-sentence AI commentary as the setup evolves
- **Signal engine** - volume breakout scoring, buy pressure, concentration, age, abnormal candles, and EMA9 x EMA21 context
- **Local live dashboard** - Express dashboard with server-sent updates, mini volume bars, expandable ticker views, and chat

---

## AI agents

Prati uses a tiered agent stack. The scanner is the data layer; the agents are the decision layer.

| Agent | Role | Example output |
|---|---|---|
| **Spotter** | Background board triage every few scans | "NEW", "ACCELERATING", "FADING", "PERSISTENT", "avoid" |
| **Research** | Deep dive on one ticker | Volume structure, timing phase, direction, conviction, bottom line |
| **Ticker chat** | Direct per-ticker analyst | Verdict, stop, horizon, conviction |
| **Global chat** | Conversational scan intelligence | Strongest setup, sector movement, false positives, what changed |
| **Pin commentary** | Ongoing monitor for pinned tickers | Current status plus what would change the picture |

The AI layer receives compact structured context: current metrics, recent scan trajectory, pinned tickers, mentioned ticker klines, and the latest 1-minute candles. It is designed to make the discussion concrete instead of generic.

Example prompts:

```text
Should I long or short EIGENUSDT?
Brief me on this ticker. What is happening right now?
Is this spike accumulation or a stop hunt?
What invalidates this setup?
Which signal is freshest and highest conviction?
Any red flags in the top 15?
```

---

## Signal engine

Prati scans Bitunix public futures data, read-only:

- Around 135 mid/small-cap USDT perpetual tickers
- 200 one-minute candles per ticker
- 24h volume filters to avoid mega-caps and dead markets
- No database; scan state lives in memory
- Server-sent events push fresh scans to the browser

Per ticker, Prati computes:

- **Baseline** - average 1-minute USDT volume over the lookback window
- **Recent volume** - last 5 one-minute candles
- **Score** - average volume ratio times abnormal candle count, with EMA context
- **Concentration** - percentage of the last hour's volume happening in the last 5 minutes
- **Buy pressure** - green-candle volume as a percentage of recent volume
- **Age and trajectory** - whether a signal is new, building, stale, or fading
- **Triple confirmation** - score > 15, concentration > 40, and buy pressure > 80

---

## Installation

```bash
git clone https://github.com/boldtonic/prati.git
cd prati
cd "prati breakout"
npm install
```

Run without AI features:

```bash
node prati.js
```

Run with optional Anthropic-powered analysis:

```bash
ANTHROPIC_API_KEY=your_key_here node prati.js
```

Open `http://localhost:3000`.

---

## Example workflow

1. Let the scanner build the board from live Bitunix public market data.
2. Watch the Spotter agent call out fresh or accelerating names.
3. Open a ticker to get an automatic AI brief.
4. Ask the ticker chat: "Should I long or short this?" or "What invalidates it?"
5. Pin tickers you care about and let Prati keep monitoring them.
6. Use the global chat to compare setups across the whole scan.

---

## Optional frontend workspace

The `client/` folder contains the React/Vite dashboard workspace used during UI iteration.

```bash
cd client
npm install
npm run build
```

The main runtime currently serves `dashboard.html` from the project folder.

---

## Data and keys

| Provider | What it adds | Required |
|---|---|---|
| **Bitunix public futures API** | Market tickers, 1-minute klines, 24h volume | Yes |
| **Anthropic** | Spotter, research, ticker chat, global chat, pin commentary | Optional |

Prati uses public market endpoints for scanner data. AI features read `ANTHROPIC_API_KEY` from your local environment and are disabled when it is not set. Exchange API keys are not needed because Prati does not place trades.

---

## Not financial advice

Prati is decision-support software for traders, not financial advice. It can analyze setups, explain long/short arguments, identify invalidation points, and monitor pinned tickers, but you make the final trading decision.

---

## License

MIT - see [LICENSE](LICENSE) for details.
