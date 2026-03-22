import type { Candle } from '../lib/types'

interface Props {
  candles: Candle[]
  baselineAvg: number
  width?: number
  height?: number
}

export default function MiniChart({ candles, baselineAvg, width = 105, height = 28 }: Props) {
  if (!candles.length) return null
  const maxVol = Math.max(...candles.map(c => c.baseVol), 1)
  const bW = 3, bG = 1
  const svgW = candles.length * (bW + bG) - bG
  const baseH = Math.min(height - 1, Math.max(1, (baselineAvg / maxVol) * height))
  const baseY = (height - baseH).toFixed(1)

  return (
    <svg width={svgW} height={height} style={{ display: 'block' }}>
      <line x1={0} y1={baseY} x2={svgW} y2={baseY} stroke="#1e3a5f" strokeDasharray="2,3" strokeWidth={1} />
      {candles.map((c, j) => {
        const x  = j * (bW + bG)
        const bH = Math.max(2, (c.baseVol / maxVol) * height)
        const y  = (height - bH).toFixed(1)
        const col = c.close >= c.open ? '#22c55e' : '#ef4444'
        const op  = j >= candles.length - 5 ? 1 : 0.2
        return <rect key={j} x={x} y={y} width={bW} height={bH.toFixed(1)} fill={col} opacity={op} />
      })}
    </svg>
  )
}
