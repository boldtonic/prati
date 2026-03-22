import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { ScanResult } from './types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function fmtAge(age: number): string {
  return age === 0 ? '<1m' : `${age}m`
}

export function fmtPct(v: number): string {
  const c = Math.min(9999, Math.max(-999, v))
  return `${c >= 0 ? '+' : ''}${c.toFixed(0)}%`
}

export function fmtVol(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`
  return v.toFixed(0)
}

export function shortSym(symbol: string): string {
  return symbol.replace(/USDT$/, '')
}

export function isTriple(r: ScanResult): boolean {
  return r.score > 15 && r.conc > 40 && r.bp > 80
}

export function scoreColor(score: number): string {
  if (score > 25) return 'text-purple'
  if (score > 15) return 'text-purple/70'
  if (score >= 5) return 'text-amber'
  return 'text-t3'
}

export function scoreBg(score: number): string {
  if (score > 25) return 'bg-purple'
  if (score > 15) return 'bg-purple/60'
  if (score >= 5) return 'bg-amber/70'
  return 'bg-t3/40'
}
