import { describe, expect, it } from 'vitest'
import { ROLE_GLYPH, roleColor, roleMarkerSvg } from './roles'

const md3 = { primary: '#111111', tertiary: '#222222', outline: '#333333' }

describe('role helpers', () => {
  it('keeps role glyphs aligned with map marker shapes', () => {
    expect(ROLE_GLYPH).toMatchObject({
      repeater: '◆',
      companion: '●',
      room: '⬡',
      sensor: '▲',
    })
  })

  it('maps roles to canonical colors', () => {
    expect(roleColor('repeater', md3)).toBe(md3.primary)
    expect(roleColor('companion', md3)).toBe(md3.tertiary)
    expect(roleColor('room', md3)).toBe('#22c55e')
    expect(roleColor('sensor', md3)).toBe('#f59e0b')
    expect(roleColor('unknown', md3)).toBe(md3.outline)
  })

  it('renders deterministic SVG marker shapes', () => {
    expect(roleMarkerSvg('repeater', '#abc')).toContain('<polygon points="10,1 19,10 10,19 1,10"')
    expect(roleMarkerSvg('companion', '#abc')).toContain('<circle cx="10" cy="10"')
    expect(roleMarkerSvg('unknown', '#abc')).toContain('<circle cx="10" cy="10"')
  })
})
