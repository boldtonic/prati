import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { cn, fmtAge, fmtPct, shortSym, isTriple, scoreColor, scoreBg } from '../lib/utils'
import MiniChart from '../components/MiniChart'
import type { ScanResult } from '../lib/types'

// ── Status pill ──────────────────────────────────────────────────────────────

function StatusPill() {
  const status = useStore(s => s.status)
  const meta   = useStore(s => s.meta)
  const last   = useStore(s => s.lastScanMs)

  const [secs, setSecs] = useState(0)
  if (last) {
    const elapsed = Math.round((Date.now() - last) / 1000)
    if (elapsed !== secs) setSecs(elapsed)
  }

  if (status === 'connecting') {
    return (
      <span className="flex items-center gap-1.5 text-t3 text-xs font-mono">
        <span className="w-1.5 h-1.5 rounded-full bg-t3 inline-block" />
        Connecting…
      </span>
    )
  }
  if (status === 'scanning') {
    return (
      <span className="flex items-center gap-1.5 text-amber text-xs font-mono">
        <span className="w-1.5 h-1.5 rounded-full bg-amber inline-block animate-pulse" />
        Scanning…
      </span>
    )
  }
  if (status === 'live') {
    return (
      <span className="flex items-center gap-2 text-xs font-mono">
        <span className="flex items-center gap-1.5 text-green">
          <span className="w-1.5 h-1.5 rounded-full bg-green inline-block animate-pulse" />
          Live
        </span>
        {meta && (
          <span className="text-t3">
            {meta.eligibleCount} tickers · {secs}s
          </span>
        )}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1.5 text-red text-xs font-mono">
      <span className="w-1.5 h-1.5 rounded-full bg-red inline-block" />
      Disconnected
    </span>
  )
}

// ── Age color ────────────────────────────────────────────────────────────────

function ageClass(age: number): string {
  if (age < 5)  return 'text-amber font-semibold'
  if (age <= 15) return 'text-t2'
  return 'text-t3'
}

// ── BP color ─────────────────────────────────────────────────────────────────

function bpClass(bp: number): string {
  if (bp > 80)  return 'text-green'
  if (bp < 30)  return 'text-red'
  return 'text-t3'
}

// ── Score bar cell ────────────────────────────────────────────────────────────

function ScoreCell({ score }: { score: number }) {
  const pct = Math.min(100, (score / 30) * 100)
  return (
    <div className="relative h-5 flex items-center min-w-[80px]">
      <div
        className={cn('absolute left-0 top-0 bottom-0 rounded-sm', scoreBg(score))}
        style={{ width: `${pct}%` }}
      />
      <span className={cn('relative z-10 tabular-nums text-xs font-semibold pl-1.5', scoreColor(score))}>
        {score.toFixed(1)}
      </span>
    </div>
  )
}

// ── Main Radar page ───────────────────────────────────────────────────────────

export default function Radar() {
  const navigate   = useNavigate()
  const results    = useStore(s => s.results)
  const ignitions  = useStore(s => s.ignitions)
  const [showAll, setShowAll] = useState(false)

  const visible = results.filter(r => r.age <= 30)
  const filtered = visible.filter(r => r.score >= 3)
  const hidden   = visible.filter(r => r.score < 3)

  const rows: ScanResult[] = showAll ? visible : filtered

  function handleRowClick(e: React.MouseEvent, symbol: string) {
    // Don't double-navigate if the ticker link was clicked
    if ((e.target as HTMLElement).closest('a, button')) return
    navigate(`/ticker/${symbol}`)
  }

  return (
    <div className="flex flex-col h-screen bg-bg text-t1 overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-4 h-11 bg-s1 border-b border-bd flex-shrink-0">
        {/* Brand */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-purple font-semibold text-sm">प्रति Prati</span>
          <span className="text-t3 text-xs font-mono">v0.3</span>
        </div>

        {/* Ignition pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto flex-1 mx-4 scrollbar-none">
          {ignitions.map(ig => (
            <button
              key={ig.symbol}
              onClick={() => navigate(`/ticker/${ig.symbol}`)}
              className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono bg-amber/10 text-amber border border-amber/20 hover:bg-amber/20 transition-colors"
            >
              ⚡ {shortSym(ig.symbol)} {ig.ratio.toFixed(0)}×
            </button>
          ))}
        </div>

        {/* Right: status + chat */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <StatusPill />
          <button
            onClick={() => navigate('/chat')}
            className="text-t3 hover:text-t1 transition-colors text-sm"
            aria-label="Open scan chat"
          >
            💬
          </button>
        </div>
      </header>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-s1 z-10">
            <tr className="text-t2 text-[11px] uppercase tracking-widest">
              <th className="w-8 text-right pr-2 py-2 font-medium">#</th>
              <th className="w-24 text-left pl-3 py-2 font-medium">Ticker</th>
              <th className="w-28 text-left pl-2 py-2 font-medium">Score</th>
              <th className="w-11 text-right pr-3 py-2 font-medium">Age</th>
              <th className="w-11 text-right pr-3 py-2 font-medium">BP%</th>
              <th className="text-left pl-3 py-2 font-medium">▬▬▬</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && results.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-16 text-t2 text-sm">
                  Waiting for first scan…
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr
                key={r.symbol}
                onClick={(e) => handleRowClick(e, r.symbol)}
                className={cn(
                  'cursor-pointer hover:bg-s2/50 transition-colors border-b border-bd/30',
                  isTriple(r) && 'border-l-2 border-amber'
                )}
              >
                {/* # */}
                <td className="text-right pr-2 py-2 text-t3 text-xs font-mono w-8">
                  {i + 1}
                </td>

                {/* TICKER */}
                <td className="pl-3 py-2 w-24">
                  <button
                    onClick={(e) => { e.stopPropagation(); navigate(`/ticker/${r.symbol}`) }}
                    className="text-blue font-mono font-medium text-sm hover:underline"
                  >
                    {shortSym(r.symbol)}
                  </button>
                </td>

                {/* SCORE */}
                <td className="pl-2 py-2 w-28">
                  <ScoreCell score={r.score} />
                </td>

                {/* AGE */}
                <td className={cn('text-right pr-3 py-2 font-mono text-xs w-11', ageClass(r.age))}>
                  {fmtAge(r.age)}
                </td>

                {/* BP% */}
                <td className={cn('text-right pr-3 py-2 font-mono text-xs w-11', bpClass(r.bp))}>
                  {fmtPct(r.bp)}
                </td>

                {/* Sparkline */}
                <td className="pl-3 py-1.5">
                  <MiniChart
                    candles={r.miniCandles}
                    baselineAvg={r.baselineAvg}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Show more / less link */}
        {!showAll && hidden.length > 0 && (
          <div className="text-center py-4">
            <button
              onClick={() => setShowAll(true)}
              className="text-t3 text-xs font-mono hover:text-t2 transition-colors"
            >
              ↓ {hidden.length} more signal{hidden.length !== 1 ? 's' : ''}
            </button>
          </div>
        )}
        {showAll && hidden.length > 0 && (
          <div className="text-center py-4">
            <button
              onClick={() => setShowAll(false)}
              className="text-t3 text-xs font-mono hover:text-t2 transition-colors"
            >
              ↑ hide low signals
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
