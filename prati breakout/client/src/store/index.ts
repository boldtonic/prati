import { create } from 'zustand'
import type { ScanResult, ScanMeta, IgnitionEvent, PinCommentary, Status } from '../lib/types'

interface Store {
  status: Status
  results: ScanResult[]
  meta: ScanMeta | null
  lastScanMs: number | null
  ignitions: IgnitionEvent[]
  pins: Set<string>
  pinCommentary: Record<string, PinCommentary>

  setStatus: (s: Status) => void
  onScan: (d: { results: ScanResult[]; scanTime: string; duration: string; eligibleCount: number }) => void
  onIgnition: (d: IgnitionEvent) => void
  onPins: (pins: string[]) => void
  onPinCommentary: (d: { symbol: string; text: string; updatedAt: string }) => void
  pinTicker: (symbol: string) => void
  unpinTicker: (symbol: string) => void
}

export const useStore = create<Store>((set) => ({
  status:        'connecting',
  results:       [],
  meta:          null,
  lastScanMs:    null,
  ignitions:     [],
  pins:          new Set(),
  pinCommentary: {},

  setStatus: (status) => set({ status }),

  onScan: (d) => set({
    results:    d.results ?? [],
    meta:       { scanTime: d.scanTime, duration: d.duration, eligibleCount: d.eligibleCount },
    lastScanMs: Date.now(),
    status:     'live',
  }),

  onIgnition: (d) => set((s) => ({
    ignitions: [d, ...s.ignitions.filter(i => i.symbol !== d.symbol)].slice(0, 5),
  })),

  onPins: (pins) => set({ pins: new Set(pins) }),

  onPinCommentary: ({ symbol, text, updatedAt }) => set((s) => ({
    pinCommentary: { ...s.pinCommentary, [symbol]: { text, updatedAt } },
  })),

  pinTicker:   (symbol) => fetch(`/api/pins/${symbol}`, { method: 'POST' }).catch(() => {}),
  unpinTicker: (symbol) => fetch(`/api/pins/${symbol}`, { method: 'DELETE' }).catch(() => {}),
}))
