import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store'
import { cn, fmtAge, fmtPct, scoreColor } from '../lib/utils'
import ExtendedChart from '../components/ExtendedChart'
import type { Message } from '../lib/types'

// ── Markdown rendering ────────────────────────────────────────────────────────

function inline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
}

function renderMarkdown(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const lines = escaped.split('\n')
  let html = ''
  let inList = false

  for (const line of lines) {
    if (/^---+$/.test(line.trim())) {
      if (inList) { html += '</ul>'; inList = false }
      html += '<hr style="border-color:#1e2d45;margin:8px 0">'
      continue
    }
    const h2 = line.match(/^##\s+(.+)$/)
    if (h2) {
      if (inList) { html += '</ul>'; inList = false }
      html += `<div style="font-weight:600;color:#e2e8f0;margin:6px 0 2px">${inline(h2[1])}</div>`
      continue
    }
    const li = line.match(/^[-*]\s+(.+)$/)
    if (li) {
      if (!inList) { html += '<ul style="padding-left:14px;margin:4px 0">'; inList = true }
      html += `<li style="margin:2px 0">${inline(li[1])}</li>`
      continue
    }
    if (line.trim() === '') {
      if (inList) { html += '</ul>'; inList = false }
      html += '<div style="height:6px"></div>'
      continue
    }
    if (inList) { html += '</ul>'; inList = false }
    html += `<p style="margin:2px 0">${inline(line)}</p>`
  }
  if (inList) html += '</ul>'
  return html
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ageClass(age: number): string {
  if (age < 5) return 'text-amber font-semibold'
  if (age <= 15) return 'text-t2'
  return 'text-t3'
}

function bpClass(bp: number): string {
  if (bp > 80) return 'text-green'
  if (bp < 30) return 'text-red'
  return 'text-t3'
}

function concClass(conc: number): string {
  if (conc > 60) return 'text-red'
  if (conc > 40) return 'text-amber'
  return 'text-t2'
}

function fmtTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const QUICK_CHIPS = [
  '⚡ Quick verdict',
  'Real or stop hunt?',
  'Fading or building?',
  'Entry & stop',
  'Red flags',
]

// ── Main ─────────────────────────────────────────────────────────────────────

export default function TickerRoom() {
  const navigate = useNavigate()
  const { symbol } = useParams<{ symbol: string }>()

  const results      = useStore(s => s.results)
  const pins         = useStore(s => s.pins)
  const pinTicker    = useStore(s => s.pinTicker)
  const unpinTicker  = useStore(s => s.unpinTicker)

  const result = results.find(r => r.symbol === symbol)
  const isPinned = symbol ? pins.has(symbol) : false

  const [messages, setMessages] = useState<(Message & { ts: Date })[]>([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [userSent, setUserSent] = useState(false)
  const messagesEndRef           = useRef<HTMLDivElement>(null)
  const textareaRef              = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Auto-brief on mount
  useEffect(() => {
    if (!symbol) return
    sendMessage('Brief me on this ticker. What\'s happening?', [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol])

  async function sendMessage(text: string, history: Message[]) {
    setLoading(true)

    // Add user message (skip for auto-brief)
    const isAutoBrief = history.length === 0 && text.startsWith('Brief me')
    const now = new Date()

    if (!isAutoBrief) {
      setMessages(prev => [...prev, { role: 'user', content: text, ts: now }])
    }

    // Add loading placeholder
    const loadingMsg = { role: 'assistant' as const, content: '', loading: true, ts: new Date() }
    setMessages(prev => [...prev, loadingMsg])

    try {
      const res = await fetch('/api/ticker-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, message: text, history }),
      })
      const data = await res.json()
      const reply = data.reply ?? data.message ?? 'No response.'

      setMessages(prev => {
        const next = [...prev]
        const idx  = next.findLastIndex(m => m.loading)
        if (idx !== -1) next[idx] = { role: 'assistant', content: reply, ts: new Date() }
        return next
      })
    } catch {
      setMessages(prev => {
        const next = [...prev]
        const idx  = next.findLastIndex(m => m.loading)
        if (idx !== -1) next[idx] = { role: 'assistant', content: 'Error fetching response.', ts: new Date() }
        return next
      })
    } finally {
      setLoading(false)
    }
  }

  function buildHistory(): Message[] {
    return messages
      .filter(m => !m.loading)
      .map(m => ({ role: m.role, content: m.content }))
  }

  function handleSend(text: string) {
    const trimmed = text.trim()
    if (!trimmed || loading) return
    setUserSent(true)
    sendMessage(trimmed, buildHistory())
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend(input)
      setInput('')
    }
  }

  function handleTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value)
    // Auto-grow
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 96) + 'px'
  }

  function handleChipClick(chip: string) {
    setUserSent(true)
    sendMessage(chip, buildHistory())
  }

  function handlePin() {
    if (!symbol) return
    if (isPinned) unpinTicker(symbol)
    else pinTicker(symbol)
  }

  return (
    <div className="flex flex-col h-screen bg-bg text-t1 overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 h-11 bg-s1 border-b border-bd flex-shrink-0">
        {/* Back */}
        <button
          onClick={() => navigate('/')}
          className="text-t2 hover:text-t1 transition-colors text-base font-mono flex-shrink-0"
          aria-label="Back to radar"
        >
          ←
        </button>

        {/* Symbol */}
        <span className="font-mono font-bold text-t1 text-lg flex-shrink-0">
          {symbol}
        </span>

        {/* Vitals */}
        {result ? (
          <div className="flex items-center gap-3 font-mono text-xs overflow-x-auto scrollbar-none flex-1">
            <span className={scoreColor(result.score)}>
              {result.score.toFixed(1)}
            </span>
            <span className={ageClass(result.age)}>
              {fmtAge(result.age)}
            </span>
            <span className={bpClass(result.bp)}>
              BP {fmtPct(result.bp)}
            </span>
            <span className={concClass(result.conc)}>
              C {result.conc.toFixed(0)}%
            </span>
          </div>
        ) : (
          <div className="flex items-center flex-1">
            <span className="text-t3 text-xs font-mono">Not in current scan</span>
          </div>
        )}

        {/* Pin */}
        <button
          onClick={handlePin}
          className={cn(
            'flex-shrink-0 text-xs font-mono px-2 py-0.5 rounded border transition-colors',
            isPinned
              ? 'border-amber/40 text-amber bg-amber/10 hover:bg-amber/20'
              : 'border-bd text-t3 hover:text-t1 hover:border-t3'
          )}
        >
          {isPinned ? '📌' : '+ Pin'}
        </button>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Chart */}
        <div className="flex flex-col w-[55%] overflow-hidden py-4 px-4 border-r border-bd">
          <ExtendedChart
            candles={result?.miniCandles ?? []}
            baselineAvg={result?.baselineAvg ?? null}
          />
        </div>

        {/* Right: Conversation */}
        <div className="flex flex-col w-[45%] h-full overflow-hidden">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
            {messages.map((m, i) => (
              <div
                key={i}
                className={cn('flex flex-col gap-0.5', m.role === 'user' ? 'items-end' : 'items-start')}
              >
                {m.loading ? (
                  <div className="text-t3 text-sm animate-pulse">···</div>
                ) : m.role === 'assistant' ? (
                  <div
                    className="text-t1 text-sm leading-[1.65] max-w-[90%]"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                  />
                ) : (
                  <div className="text-t2 text-sm max-w-[80%] whitespace-pre-wrap">
                    {m.content}
                  </div>
                )}
                {!m.loading && (
                  <span className="text-[10px] text-t3 font-mono">{fmtTime(m.ts)}</span>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick chips — only before first user message */}
          {!userSent && (
            <div className="px-4 pb-2 flex flex-wrap gap-1.5">
              {QUICK_CHIPS.map(chip => (
                <button
                  key={chip}
                  onClick={() => handleChipClick(chip)}
                  disabled={loading}
                  className="text-xs px-2 py-1 rounded border border-bd bg-s1 text-t2 hover:border-purple hover:text-t1 transition-colors disabled:opacity-50"
                >
                  {chip}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="flex-shrink-0 border-t border-bd pt-3 pb-3 px-4">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              disabled={loading}
              placeholder="ask anything…"
              className={cn(
                'w-full bg-transparent border border-bd rounded px-3 py-2 text-sm text-t1 placeholder-t3 resize-none outline-none focus:border-t3 transition-colors',
                loading && 'cursor-default opacity-60'
              )}
              style={{ maxHeight: '96px', overflowY: 'auto' }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
