import { describe, expect, it } from 'vitest'
import { groupCountries, passesGeo, passesRegion, selectedCountries } from './regions'

describe('region helpers', () => {
  it('groups valid IATA codes by country and sorts unknowns last', () => {
    expect(groupCountries(['waw', 'LUZ', 'bad1', 'QQQ'])).toEqual([
      { cc: 'PL', codes: ['LUZ', 'WAW'] },
      { cc: 'XX', codes: ['QQQ'] },
    ])
  })

  it('applies inclusive and locked observer-region filters', () => {
    const selected = new Set(['WAW', 'LUZ'])

    expect(passesRegion(['WAW', 'BER'], selected, false)).toBe(true)
    expect(passesRegion(['WAW', 'BER'], selected, true)).toBe(false)
    expect(passesRegion(['WAW', 'LUZ'], selected, true)).toBe(true)
    expect(passesRegion(undefined, selected, false)).toBe(false)
  })

  it('maps selected IATA codes to distinct country codes', () => {
    expect(selectedCountries(new Set(['WAW', 'LUZ', 'QQQ'])).sort()).toEqual(['PL'])
  })

  it('applies strict geographic country filters', () => {
    expect(passesGeo('PL', new Set(['PL']))).toBe(true)
    expect(passesGeo('DE', new Set(['PL']))).toBe(false)
    expect(passesGeo(undefined, new Set(['PL']))).toBe(false)
    expect(passesGeo(undefined, new Set())).toBe(true)
  })
})
