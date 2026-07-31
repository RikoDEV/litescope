import { describe, expect, it } from 'vitest'
import { iataCountry, isIataCode } from './flags'

describe('iataCountry', () => {
  it('resolves a known IATA code case-insensitively', () => {
    expect(iataCountry('waw')).toBe('PL')
    expect(iataCountry('WAW')).toBe('PL')
  })

  it('returns an empty string for unknown or nullish input', () => {
    expect(iataCountry('QQQ')).toBe('')
    expect(iataCountry('')).toBe('')
    expect(iataCountry(null)).toBe('')
    expect(iataCountry(undefined)).toBe('')
  })
})

describe('isIataCode', () => {
  it('accepts exactly three letters, either case', () => {
    expect(isIataCode('WAW')).toBe(true)
    expect(isIataCode('waw')).toBe(true)
  })

  it('rejects non-3-letter or non-alphabetic input', () => {
    expect(isIataCode('WA')).toBe(false)
    expect(isIataCode('WAWA')).toBe(false)
    expect(isIataCode('W4W')).toBe(false)
    expect(isIataCode('')).toBe(false)
    expect(isIataCode(null)).toBe(false)
    expect(isIataCode(undefined)).toBe(false)
  })
})
