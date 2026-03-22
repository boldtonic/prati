export interface Candle {
  open: number
  close: number
  baseVol: number
  time: number
}

export interface ScanResult {
  symbol: string
  vol24h: number
  score: number
  avgRatio: number
  consecutiveAbnormal: number
  baselineAvg: number
  recentAvg: number
  currentClose: number
  vol5m: number
  vol1h: number
  conc: number
  bp: number
  age: number
  miniCandles: Candle[]
}

export interface ScanMeta {
  scanTime: string
  duration: string
  eligibleCount: number
}

export interface IgnitionEvent {
  symbol: string
  ratio: number
  vol: number
  baseline: number
  candle: { open: number; close: number; time: number }
  score: number
  bp: number
  age: number
}

export interface PinCommentary {
  text: string
  updatedAt: string
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
  loading?: boolean
}

export type Status = 'connecting' | 'scanning' | 'live' | 'dead'
