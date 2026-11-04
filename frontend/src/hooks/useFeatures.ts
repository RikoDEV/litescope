import { useEffect, useState } from 'react'
import { api, type Features } from '../services/api'

const DISABLED: Features = { coverage: false }

/**
 * Backend feature flags. Until the (once-per-page-load) request resolves every
 * feature reads as disabled, so gated controls appear only once confirmed.
 */
export function useFeatures(): Features {
  const [features, setFeatures] = useState<Features>(DISABLED)
  useEffect(() => {
    let cancelled = false
    void api.features().then(f => { if (!cancelled) setFeatures(f) })
    return () => { cancelled = true }
  }, [])
  return features
}
