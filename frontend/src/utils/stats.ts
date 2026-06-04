// Shared statistics helpers used across analytics/detail views.

/**
 * Buckets `vals` into `buckets` equal-width bins spanning [min, max] and returns
 * one entry per bin with a numeric label (bin lower bound) and the count of
 * values that fell into it. Values outside the range are clamped to the edges.
 */
export function bucketize(vals: number[], min: number, max: number, buckets: number): { label: string; count: number }[] {
  const size = (max - min) / buckets
  const counts = Array(buckets).fill(0)
  for (const v of vals) counts[Math.min(buckets - 1, Math.max(0, Math.floor((v - min) / size)))]++
  return counts.map((count, i) => ({ label: `${(min + i * size).toFixed(0)}`, count }))
}
