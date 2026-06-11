import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Node } from '../types'
import { isNodeActive } from './nodes'

const node = (role: string, hoursAgo: number): Node => ({
  pubKey: 'pk',
  name: 'node',
  role,
  lat: null,
  lon: null,
  firstSeen: '2026-06-01T00:00:00Z',
  lastSeen: new Date(Date.UTC(2026, 5, 11, 12 - hoursAgo)).toISOString(),
  advertCount: 1,
})

describe('isNodeActive', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-06-11T12:00:00Z')))
  afterEach(() => vi.useRealTimers())

  it('uses a 72 hour activity window for infrastructure roles', () => {
    expect(isNodeActive(node('repeater', 71))).toBe(true)
    expect(isNodeActive(node('room', 73))).toBe(false)
  })

  it('uses a 24 hour activity window for client roles', () => {
    expect(isNodeActive(node('companion', 23))).toBe(true)
    expect(isNodeActive(node('sensor', 25))).toBe(false)
  })
})
