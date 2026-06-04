// Shared geo-location validation.
//
// MeshCore nodes that have never set a position report 0 for one or both
// coordinates (e.g. "0.3833, 0.0000" or "0.0000, 10.6358"). Treat an exact
// zero on EITHER axis as "unset" so these phantom points stay off the map.

export function hasValidLocation(
  lat: number | null | undefined,
  lon: number | null | undefined,
): boolean {
  if (lat == null || lon == null) return false
  if (lat === 0 || lon === 0) return false
  return true
}

/** Returns [lat, lon] when valid, else null. */
export function validLatLon(
  lat: number | null | undefined,
  lon: number | null | undefined,
): [number, number] | null {
  return hasValidLocation(lat, lon) ? [lat as number, lon as number] : null
}
