import { iataCountry } from './flags'

export interface CountryGroup {
  cc: string       // ISO country code, or 'XX' for IATA codes with no known country
  codes: string[]  // sorted IATA codes belonging to this country
}

/**
 * Groups IATA region codes by their ISO country so a filter can cascade
 * country → airport. Codes with no known country fall into the 'XX' bucket,
 * which is always sorted last.
 */
export function groupCountries(iatas: string[]): CountryGroup[] {
  const map = new Map<string, string[]>()
  for (const code of iatas) {
    const cc = iataCountry(code) || 'XX'
    const arr = map.get(cc) ?? []
    arr.push(code)
    map.set(cc, arr)
  }
  return [...map.entries()]
    .map(([cc, codes]) => ({ cc, codes: codes.sort() }))
    .sort((a, b) => (a.cc === 'XX' ? 1 : b.cc === 'XX' ? -1 : a.cc.localeCompare(b.cc)))
}

/**
 * Region-filter predicate shared by packets and nodes.
 *
 * `regions` is the set of observer IATA codes that heard the item.
 * - Unlocked: passes if ANY observer is in the selected region (inclusive —
 *   "observed in").
 * - Locked: passes only if EVERY observer is within the selection (exclusive —
 *   "local only"), so long-distance propagation caught by a local observer is
 *   excluded.
 */
export function passesRegion(regions: string[] | undefined, selected: Set<string>, lock: boolean): boolean {
  if (selected.size === 0) return true
  if (lock) return !!regions?.length && regions.every(r => selected.has(r))
  return !!regions?.some(r => selected.has(r))
}

/** Maps a set of selected IATA codes to their distinct ISO country codes. */
export function selectedCountries(selected: Set<string>): string[] {
  const out = new Set<string>()
  for (const code of selected) {
    const cc = iataCountry(code)
    if (cc) out.add(cc)
  }
  return [...out]
}

/**
 * Geographic ("strict") region predicate: an item with a resolved ISO `country`
 * passes only if it's in the selected-country set. Items with no country are
 * hidden when a filter is active.
 */
export function passesGeo(country: string | undefined, countries: Set<string>): boolean {
  if (countries.size === 0) return true
  return !!country && countries.has(country)
}
