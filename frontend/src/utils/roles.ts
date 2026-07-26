// Single source of truth for node-type (role) symbols, colours and map-marker
// shapes, so every view renders repeaters/companions/rooms/sensors identically.
// The canonical shapes are the MapView markers: diamond / circle / hexagon /
// triangle, mirrored by the text glyphs below.

export const ROLES = ['repeater', 'companion', 'room', 'sensor'] as const
export type Role = (typeof ROLES)[number]

/** Text glyphs matching the map-marker shapes (◆ diamond, ● circle, ⬡ hexagon, ▲ triangle). */
export const ROLE_GLYPH: Record<string, string> = {
  repeater: '◆', companion: '●', room: '⬡', sensor: '▲',
}

interface Md3Like { primary: string; tertiary: string; outline: string }

/** Badge colour for the "also acts as an observer" marker overlay — distinct from every role colour. */
export const OBSERVER_BADGE_COLOR = '#06b6d4'

/** Theme-aware role colour. repeater→primary, companion→tertiary, room→green, sensor→amber. */
export function roleColor(role: string, md3: Md3Like): string {
  switch (role) {
    case 'repeater':  return md3.primary
    case 'companion': return md3.tertiary
    case 'room':      return '#22c55e'
    case 'sensor':    return '#f59e0b'
    default:          return md3.outline
  }
}

/**
 * SVG marker for leaflet divIcons, drawn in a 20×20 viewBox and scaled to `size`.
 * Diamond (repeater), circle (companion), hexagon (room), triangle (sensor).
 * When `isObserver` is set, a small badge is overlaid top-right — any node
 * capable of logging packets it hears (including companions) can double as
 * an observer, so this is orthogonal to role.
 */
export function roleMarkerSvg(role: string, color: string, opacity = 1, stroke = '#111827', size = 20, isObserver = false): string {
  const inner: Record<string, string> = {
    repeater:  `<polygon points="10,1 19,10 10,19 1,10" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`,
    companion: `<circle cx="10" cy="10" r="8" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`,
    room:      `<polygon points="10,1 17.6,5.5 17.6,14.5 10,19 2.4,14.5 2.4,5.5" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`,
    sensor:    `<polygon points="10,1 19,18 1,18" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`,
  }
  const badge = isObserver
    ? `<circle cx="16" cy="4" r="3.4" fill="${OBSERVER_BADGE_COLOR}" stroke="${stroke}" stroke-width="1"/><circle cx="16" cy="4" r="1.2" fill="${stroke}"/>`
    : ''
  return `<svg width="${size}" height="${size}" viewBox="0 0 20 20" style="opacity:${opacity}">${inner[role] ?? inner.companion}${badge}</svg>`
}
