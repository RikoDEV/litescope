import { describe, expect, it } from 'vitest'
import { isContact, isLocation, parseMessageSegments } from './contacts'

describe('parseMessageSegments', () => {
  it('preserves plain text when no rich tokens are present', () => {
    expect(parseMessageSegments('hello mesh')).toEqual(['hello mesh'])
  })

  it('parses contact shares and lowercases pubkeys', () => {
    const pubKey = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789'
    const segments = parseMessageSegments(`meet <${pubKey}:2:Riko Base> soon`)

    expect(segments[0]).toBe('meet ')
    expect(isContact(segments[1]!)).toBe(true)
    if (isContact(segments[1]!)) {
      expect(segments[1].pubKey).toBe(pubKey.toLowerCase())
      expect(segments[1].type).toBe(2)
      expect(segments[1].name).toBe('Riko Base')
    }
    expect(segments[2]).toBe(' soon')
  })

  it('parses valid location shares and leaves out-of-range coordinates as text', () => {
    const segments = parseMessageSegments('at 52.396421,20.918991 not 99.000,20.000')

    expect(isLocation(segments[1]!)).toBe(true)
    if (isLocation(segments[1]!)) {
      expect(segments[1]).toMatchObject({ lat: 52.396421, lon: 20.918991 })
    }
    expect(segments[3]).toBe('99.000,20.000')
  })

  it('does not match low-precision comma-separated numbers', () => {
    expect(parseMessageSegments('try channel 1,2 today')).toEqual(['try channel 1,2 today'])
  })
})
