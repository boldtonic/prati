import type { Candle } from '../lib/types'

interface Props {
  candles: Candle[]
  baselineAvg?: number | null
}

export default function ExtendedChart({ candles, baselineAvg }: Props) {
  if (!candles.length) return null

  const height = 200
  const bW = 3
  const bG = 1
  const maxVol = Math.max(...candles.map(c => c.baseVol), 1)
  const svgW = candles.length * (bW + bG) - bG

  const baseH = baselineAvg != null
    ? Math.min(height - 1, Math.max(1, (baselineAvg / maxVol) * height))
    : null
  const baseY = baseH != null ? (height - baseH).toFixed(1) : null

  const total = candles.length

  function opacity(j: number): number {
    const fromEnd = total - 1 - j
    if (fromEnd < 10) return 1
    if (fromEnd < 30) return 0.6
    return 0.25
  }

  return (
    <div className="w-full overflow-hidden">
      <svg width="100%" viewBox={`0 0 ${svgW} ${height}`} preserveAspectRatio="none" height={height} style={{ display: 'block' }}>
        {baseY != null && (
          <line
            x1={0}
            y1={baseY}
            x2={svgW}
            y2={baseY}
            stroke="#1e3a5f"
            strokeDasharray="4,4"
            strokeWidth={1}
          />
        )}
        {baseY != null && (
          <text
            x={4}
            y={Number(baseY) - 3}
            fill="#334155"
            fontSize={9}
            fontFamily="ui-monospace, monospace"
          >
            baseline
          </text>
        )}
        {candles.map((c, j) => {
          const x  = j * (bW + bG)
          const bH = Math.max(2, (c.baseVol / maxVol) * height)
          const y  = (height - bH).toFixed(1)
          const col = c.close >= c.open ? '#22c55e' : '#ef4444'
          return (
            <rect
              key={j}
              x={x}
              y={y}
              width={bW}
              height={bH.toFixed(1)}
              fill={col}
              opacity={opacity(j)}
            />
          )
        })}
      </svg>
      <div className="flex justify-between mt-1 px-0.5">
        <span className="text-t3 text-[10px] font-mono">4h ago</span>
        <span className="text-t3 text-[10px] font-mono">now</span>
      </div>
    </div>
  )
}
