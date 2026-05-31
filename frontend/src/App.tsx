import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import Packets from './pages/Packets'
import MapView from './pages/MapView'
import Nodes from './pages/Nodes'
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
          <Route path="nodes" element={<Nodes />} />
          <Route path="channels" element={<Channels />} />
          <Route path="observers" element={<Observers />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="decode" element={<Decoder />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
