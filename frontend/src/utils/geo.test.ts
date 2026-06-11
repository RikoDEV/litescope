import { describe, expect, it } from 'vitest'
import { hasValidLocation, validLatLon } from './geo'

describe('geo helpers', () => {
  it('rejects missing or zero coordinates reported by unset MeshCore nodes', () => {
    expect(hasValidLocation(null, 20)).toBe(false)
    expect(hasValidLocation(52.2, undefined)).toBe(false)
    expect(hasValidLocation(0, 20.1)).toBe(false)
    expect(hasValidLocation(52.2, 0)).toBe(false)
  })

  it('returns a tuple only for valid coordinates', () => {
    expect(validLatLon(52.396421, 20.918991)).toEqual([52.396421, 20.918991])
    expect(validLatLon(0, 20.918991)).toBeNull()
  })
})
