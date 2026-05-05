# Prati

**Self-hosted BYOK market scanner for Bitunix public futures data.**

[![License: MIT](https://img.shields.io/badge/license-MIT-gold?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-18%2B-green?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-8b5cf6?style=flat-square)]()
[![BYOK](https://img.shields.io/badge/BYOK-bring%20your%20own%20keys-f59e0b?style=flat-square)]()

Prati scans Bitunix USDT perpetual futures with public, read-only market data and surfaces unusual volume breakouts in a local dashboard. The scanner runs on your machine, keeps signal state in memory, and only calls an AI provider if you provide your own Anthropic API key.

No hosted backend. No bundled API keys. No trading permissions.

---

## What you get

- **Public market data scanner** - watches Bitunix futures tickers on a short interval
- **Breakout scoring** - compares recent 1-minute volume against a rolling baseline
- **Signal freshness** - tracks age, trajectory, concentrated volume, and buy pressure
- **EMA context** - adds EMA9 x EMA21 alignment and recent cross information
- **Local dashboard** - Express dashboard with server-sent updates
- **Optional AI layer** - BYOK Anthropic analysis for spotter notes, ticker research, and chat

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
| **Anthropic** | Optional scanner notes, ticker research, and chat | Optional |

Prati uses public market endpoints for scanner data. AI features read `ANTHROPIC_API_KEY` from your local environment and are disabled when it is not set.

---

## Safety note

Prati is an informational scanner, not trading software. It does not place orders, manage exchange accounts, or require exchange API credentials.

---

## License

MIT - see [LICENSE](LICENSE) for details.
