import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WSMessage } from '../types'

const packet = (id: number): WSMessage => ({
  type: 'packet',
  data: { id, hash: `h${id}`, firstSeen: '2026-01-01T00:00:00Z', routeType: 1, payloadType: 4, obsCount: 1, maxHops: 0 } as never,
})

describe('stream.subscribeBatched', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.resetModules() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  const load = async () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost' }, __ENV__: {} })
    const { stream, BATCH_INTERVAL_MS } = await import('./stream')
    // Deliver as the socket would, without opening one.
    const emit = (m: WSMessage) => (stream as unknown as { handlers: Set<(m: WSMessage) => void> }).handlers.forEach(h => h(m))
    return { stream, emit, BATCH_INTERVAL_MS }
  }

  it('delivers a burst as one arrival-ordered batch', async () => {
    const { stream, emit, BATCH_INTERVAL_MS } = await load()
    const batches: WSMessage[][] = []
    stream.subscribeBatched(b => batches.push(b))
    emit(packet(1)); emit(packet(2)); emit(packet(3))
    expect(batches).toHaveLength(0)
    vi.advanceTimersByTime(BATCH_INTERVAL_MS)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.map(m => m.data.id)).toEqual([1, 2, 3])
  })

  it('drops buffered messages and stops delivering after unsubscribe', async () => {
    const { stream, emit, BATCH_INTERVAL_MS } = await load()
    const handler = vi.fn()
    const unsub = stream.subscribeBatched(handler)
    emit(packet(1))
    unsub()
    vi.advanceTimersByTime(BATCH_INTERVAL_MS * 2)
    emit(packet(2))
    vi.advanceTimersByTime(BATCH_INTERVAL_MS * 2)
    expect(handler).not.toHaveBeenCalled()
  })
})
