import { useId, useMemo, useRef, useState } from 'react'
import Box from '@mui/material/Box'

export interface SparkPoint { label: string; count: number }

interface Props {
  data: SparkPoint[]
  color: string
  tooltipBg: string
  tooltipBorder: string
  tooltipText: string
  tooltipLabel: string
  /** Series name shown before the value in the tooltip (already translated). */
  valueLabel: string
}

// Fritsch–Carlson monotone cubic: the same curve shape recharts' `type="monotone"`
// draws (no overshoot below zero), as an SVG path over a 0..W × 0..H box.
function monotonePath(xs: number[], ys: number[]): string {
  const n = xs.length
  if (n === 0) return ''
  if (n === 1) return `M${xs[0]},${ys[0]}`
  const dx: number[] = [], m: number[] = []
  for (let i = 0; i < n - 1; i++) { dx[i] = xs[i + 1]! - xs[i]!; m[i] = (ys[i + 1]! - ys[i]!) / dx[i]! }
  const t: number[] = [m[0]!]
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2
  t[n - 1] = m[n - 2]!
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue }
    const a = t[i]! / m[i]!, b = t[i + 1]! / m[i]!, s = a * a + b * b
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]!; t[i + 1] = k * b * m[i]! }
  }
  let d = `M${xs[0]},${ys[0]}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3
    d += `C${xs[i]! + h},${ys[i]! + h * t[i]!} ${xs[i + 1]! - h},${ys[i + 1]! - h * t[i + 1]!} ${xs[i + 1]},${ys[i + 1]}`
  }
  return d
}

/**
 * Tiny dependency-free area sparkline with a hover tooltip. Replaces a recharts
 * AreaChart on the landing page, which pulled ~300 KB of charting code into the
 * first page load just to draw one line.
 */
export default function Sparkline({ data, color, tooltipBg, tooltipBorder, tooltipText, tooltipLabel, valueLabel }: Props) {
  const gradId = useId()
  const boxRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null)
  const W = 100, H = 100, PAD = 4

  const { line, area, ys } = useMemo(() => {
    const max = Math.max(1, ...data.map(d => d.count))
    const xs = data.map((_, i) => (data.length <= 1 ? W / 2 : (i / (data.length - 1)) * W))
    const ys = data.map(d => PAD + (1 - d.count / max) * (H - PAD))
    const line = monotonePath(xs, ys)
    const area = line ? `${line}L${xs[xs.length - 1]},${H}L${xs[0]},${H}Z` : ''
    return { line, area, ys }
  }, [data])

  const onMove = (e: React.MouseEvent) => {
    const el = boxRef.current
    if (!el || data.length === 0) return
    const r = el.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const i = Math.round(frac * (data.length - 1))
    setHover({ i, x: data.length <= 1 ? r.width / 2 : (i / (data.length - 1)) * r.width })
  }

  const p = hover ? data[hover.i] : undefined
  return (
    // Fills its parent (which must be position: relative and sized by layout).
    // A percentage height would collapse inside a stretched flex item, whose
    // height isn't "definite" for CSS — recharts' ResponsiveContainer hid that
    // by measuring with JS; absolute inset-0 takes the laid-out size directly.
    <Box ref={boxRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
      sx={{ position: 'absolute', inset: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height="100%" style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.45} />
            <stop offset="95%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {area && <path d={area} fill={`url(#${gradId})`} stroke="none" />}
        {line && <path d={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
        {hover && ys[hover.i] !== undefined && (
          <line x1={(hover.i / Math.max(1, data.length - 1)) * W} x2={(hover.i / Math.max(1, data.length - 1)) * W} y1={0} y2={H}
            stroke={color} strokeOpacity={0.35} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {hover && p && (
        <Box sx={{
          position: 'absolute', top: 0, left: hover.x, transform: hover.x > 120 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)',
          pointerEvents: 'none', background: tooltipBg, border: `1px solid ${tooltipBorder}`, borderRadius: '8px',
          px: 1, py: 0.5, fontSize: 12, whiteSpace: 'nowrap', zIndex: 1,
        }}>
          <Box sx={{ color: tooltipLabel }}>{p.label}</Box>
          <Box sx={{ color: tooltipText }}>{valueLabel} : {p.count.toLocaleString()}</Box>
        </Box>
      )}
    </Box>
  )
}
