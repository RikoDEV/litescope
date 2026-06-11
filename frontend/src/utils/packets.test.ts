import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deduplicateObs, parseHops, relativeTime } from './packets'

describe('packet helpers', () => {
  it('parses hop JSON defensively', () => {
    expect(parseHops('["AA","BB"]')).toEqual(['AA', 'BB'])
    expect(parseHops('null')).toEqual([])
    expect(parseHops('not-json')).toEqual([])
  })

  it('keeps the strongest observation per observer', () => {
    const rows = [
      { observerId: 'a', snr: 1, rssi: -90, timestamp: '2026-06-11T10:00:00Z' },
      { observerId: 'a', snr: 2, rssi: -95, timestamp: '2026-06-11T09:00:00Z' },
      { observerId: 'b', snr: 5, rssi: -80, timestamp: '2026-06-11T10:00:00Z' },
      { observerId: 'b', snr: 5, rssi: -70, timestamp: '2026-06-11T09:00:00Z' },
      { observerId: 'c', snr: null, rssi: null, timestamp: '2026-06-11T10:00:00Z' },
      { observerId: 'c', snr: null, rssi: null, timestamp: '2026-06-11T11:00:00Z' },
    ]

    expect(deduplicateObs(rows)).toEqual([rows[1], rows[3], rows[5]])
  })

  describe('relativeTime', () => {
    beforeEach(() => vi.setSystemTime(new Date('2026-06-11T12:00:00Z')))
    afterEach(() => vi.useRealTimers())

    it('formats compact second, minute, and hour buckets', () => {
      expect(relativeTime('2026-06-11T11:59:35Z')).toBe('25s ago')
      expect(relativeTime('2026-06-11T11:35:00Z')).toBe('25m ago')
      expect(relativeTime('2026-06-11T07:30:00Z')).toBe('5h ago')
    })
  })
})
