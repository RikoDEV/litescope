import { describe, expect, it } from 'vitest'
import { bucketize } from './stats'

describe('bucketize', () => {
  it('counts values into fixed-width buckets and clamps outliers', () => {
    expect(bucketize([-20, 0, 9, 10, 19, 20, 99], 0, 20, 2)).toEqual([
      { label: '0', count: 3 },
      { label: '10', count: 4 },
    ])
  })

  it('returns empty when asked for zero buckets', () => {
    expect(bucketize([1, 2, 3], 0, 10, 0)).toEqual([])
  })
})
