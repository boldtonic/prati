import { Routes, Route } from 'react-router-dom'
import { useSSE } from './hooks/useSSE'
import Radar from './pages/Radar'
import TickerRoom from './pages/TickerRoom'
import ScanChat from './pages/ScanChat'

export default function App() {
  useSSE()
  return (
    <Routes>
      <Route path="/"               element={<Radar />} />
      <Route path="/ticker/:symbol" element={<TickerRoom />} />
      <Route path="/chat"           element={<ScanChat />} />
    </Routes>
  )
}
