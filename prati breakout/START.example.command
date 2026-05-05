#!/bin/bash
cd "$(dirname "$0")"

echo "================================================"
echo "  Prati - Bitunix Volume Breakout Scanner"
echo "================================================"
echo ""
echo "Starting server..."
echo "Open http://localhost:3000 in your browser"
echo ""

# Optional BYOK AI features. Leave blank or remove this line to run scanner-only.
export ANTHROPIC_API_KEY="your_anthropic_api_key_here"

node prati.js
