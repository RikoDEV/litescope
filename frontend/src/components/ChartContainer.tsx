import { cloneElement, startTransition, useLayoutEffect, useRef, useState, type ReactElement } from 'react'

interface Props {
  /** Kept for drop-in compatibility with recharts' ResponsiveContainer; the box always fills its parent's width. */
  width?: '100%' | undefined
  height: number
  children: ReactElement<{ width?: number; height?: number }>
}

/**
 * Drop-in replacement for recharts' `ResponsiveContainer` (width="100%",
 * numeric height) that keeps chart rendering off the urgent path.
 *
 * recharts' container renders nothing until a `useEffect` measures the box and
 * calls setState — an update at default (urgent) priority, so the real chart
 * render ran synchronously and uninterruptibly even when the data that
 * produced it arrived inside `startTransition`. With many charts per tab that
 * blocked tab switching and input for the whole render.
 *
 * Here the width is measured before paint, but the state update that renders
 * the chart (and every later resize) is a transition: React renders it
 * interruptibly and yields to the browser between charts. The box reserves
 * its height from the first paint, so nothing shifts when the chart appears.
 */
export default function ChartContainer({ height, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const apply = (w: number) => {
      const rounded = Math.floor(w)
      startTransition(() => setWidth(prev => (prev === rounded ? prev : rounded)))
    }
    apply(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) apply(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={ref} style={{ width: '100%', height, minWidth: 0 }}>
      {width > 0 && cloneElement(children, { width, height })}
    </div>
  )
}
