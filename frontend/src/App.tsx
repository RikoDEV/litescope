import { lazy } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'

// Route-level code splitting: each page becomes its own chunk, so heavy
// dependencies load only when their page is visited (leaflet/markercluster on
// the map pages, recharts on the chart pages). The Suspense boundary lives in
// Layout around the Outlet, keeping the nav shell mounted while a chunk loads.
const Home        = lazy(() => import('./pages/Home'))
const Packets     = lazy(() => import('./pages/Packets'))
const MapView     = lazy(() => import('./pages/MapView'))
const LiveMap     = lazy(() => import('./pages/LiveMap'))
const Nodes       = lazy(() => import('./pages/Nodes'))
const NodePage    = lazy(() => import('./pages/NodePage'))
const Channels    = lazy(() => import('./pages/Channels'))
const Observers   = lazy(() => import('./pages/Observers'))
const Analytics   = lazy(() => import('./pages/Analytics'))
const Decoder     = lazy(() => import('./pages/Decoder'))
const NotFound    = lazy(() => import('./pages/NotFound'))
const PacketTrace = lazy(() => import('./pages/PacketTrace'))
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'))

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="packets" element={<Packets />} />
          <Route path="packets/:hash/trace" element={<PacketTrace />} />
          <Route path="map" element={<MapView />} />
          <Route path="live" element={<LiveMap />} />
          <Route path="nodes" element={<Nodes />} />
          <Route path="nodes/:pubkey" element={<NodePage />} />
          <Route path="channels" element={<Channels />} />
          <Route path="channels/:hash" element={<Channels />} />
          <Route path="observers" element={<Observers />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="analytics/:tab" element={<Analytics />} />
          <Route path="decode" element={<Decoder />} />
          <Route path="privacy" element={<PrivacyPolicy />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
