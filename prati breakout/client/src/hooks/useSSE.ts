import { useEffect } from 'react'
import { useStore } from '../store'

export function useSSE() {
  const { setStatus, onScan, onIgnition, onPins, onPinCommentary } = useStore()

  useEffect(() => {
    const es = new EventSource('/api/stream')

    es.onerror = () => setStatus('dead')

    es.onmessage = (e) => {
      const d = JSON.parse(e.data)
      switch (d.type) {
        case 'scanning':       setStatus('scanning'); break
        case 'scan':           onScan(d); break
        case 'ignition':       onIgnition(d); break
        case 'pins':           onPins(d.pins); break
        case 'pin_commentary': onPinCommentary(d); break
      }
    }

    return () => es.close()
  }, []) // eslint-disable-line
}
