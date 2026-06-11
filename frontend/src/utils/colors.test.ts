import { describe, expect, it } from 'vitest'
import { hashColor } from './colors'

describe('hashColor', () => {
  it('returns stable HSL colors for labels', () => {
    expect(hashColor('abc')).toBe(hashColor('abc'))
    expect(hashColor('abc')).toMatch(/^hsl\(\d+, 65%, 55%\)$/)
    expect(hashColor('abc')).not.toBe(hashColor('abd'))
  })
})
