import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import Packets from './pages/Packets'
import MapView from './pages/MapView'
import TraceMap from './pages/TraceMap'
import Nodes from './pages/Nodes'
import NodePage from './pages/NodePage'
import Channels from './pages/Channels'
import Observers from './pages/Observers'
import Analytics from './pages/Analytics'
import Decoder from './pages/Decoder'
import NotFound from './pages/NotFound'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="packets" element={<Packets />} />
          <Route path="map" element={<MapView />} />
          <Route path="live" element={<TraceMap />} />
          <Route path="nodes" element={<Nodes />} />
          <Route path="nodes/:pubkey" element={<NodePage />} />
          <Route path="channels" element={<Channels />} />
          <Route path="channels/:hash" element={<Channels />} />
          <Route path="observers" element={<Observers />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="decode" element={<Decoder />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
