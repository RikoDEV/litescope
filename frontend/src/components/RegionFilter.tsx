import { useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Typography from '@mui/material/Typography'
import Tooltip from '@mui/material/Tooltip'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import LockIcon from '@mui/icons-material/Lock'
import LockOpenIcon from '@mui/icons-material/LockOpen'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import { IataFlag, FlagByCC } from '../utils/flags'
import { groupCountries } from '../utils/regions'

interface Props {
  iatas: string[]
  /** Selected IATA codes. */
  value: Set<string>
  onChange: (next: Set<string>) => void
  /** Exclusive "local only" mode (see passesRegion). */
  lock: boolean
  onLockChange: (next: boolean) => void
  /** Show the inline "Region" label (hide it when the parent provides a heading). */
  showLabel?: boolean
}

/**
 * Country → IATA cascade region filter shared by the Packets and Map views.
 * Clicking a country selects all its airports and reveals them for narrowing;
 * the lock chip switches between inclusive ("observed in") and exclusive
 * ("local only") matching.
 */
export default function RegionFilter({ iatas, value, onChange, lock, onLockChange, showLabel = true }: Props) {
  const theme = useTheme(); const md3 = theme.palette.md3
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<string | null>(null)

  const countries = useMemo(() => groupCountries(iatas), [iatas])
  if (countries.length === 0) return null

  const selCount = (codes: string[]) => codes.filter(c => value.has(c)).length
  const countryState = (codes: string[]): 'all' | 'some' | 'none' => {
    const n = selCount(codes)
    return n === 0 ? 'none' : n === codes.length ? 'all' : 'some'
  }
  const toggleRegion = (code: string) => {
    const n = new Set(value); n.has(code) ? n.delete(code) : n.add(code); onChange(n)
  }
  const toggleCountry = (cc: string, codes: string[]) => {
    const n = new Set(value)
    if (countryState(codes) === 'all') codes.forEach(c => n.delete(c))
    else codes.forEach(c => n.add(c))
    onChange(n)
    if (codes.length > 1) setExpanded(prev => (prev === cc ? prev : cc))
  }
  const clear = () => { onChange(new Set()); setExpanded(null); onLockChange(false) }

  const subCodes = expanded ? countries.find(c => c.cc === expanded)?.codes ?? [] : []

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}>
        {showLabel && <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, width: 40, flexShrink: 0 }}>{t('common.region')}</Typography>}
        <Chip label={t('common.all')} size="small" clickable onClick={clear}
          sx={{ background: value.size === 0 ? alpha(md3.secondary, 0.2) : 'transparent', color: value.size === 0 ? md3.secondary : md3.onSurfaceVariant, border: `1px solid ${value.size === 0 ? md3.secondary : md3.outlineVariant}` }} />
        {countries.map(({ cc, codes }) => {
          const state = countryState(codes)
          const active = state !== 'none'
          const open = expanded === cc
          return (
            <Chip key={cc} size="small" clickable onClick={() => toggleCountry(cc, codes)}
              label={
                <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  {cc === 'XX' ? <Box component="span" sx={{ fontSize: 11 }}>🌐</Box> : <FlagByCC cc={cc} size={12} />}
                  {cc === 'XX' ? '?' : cc}
                  {codes.length > 1 && <Box component="span" sx={{ opacity: 0.7, fontSize: 10 }}>· {state === 'some' ? `${selCount(codes)}/${codes.length}` : codes.length}</Box>}
                  {codes.length > 1 && (open ? <ExpandLessIcon sx={{ fontSize: 13, ml: -0.25 }} /> : <ExpandMoreIcon sx={{ fontSize: 13, ml: -0.25 }} />)}
                </Box>
              }
              sx={{ background: active ? alpha(md3.secondary, state === 'all' ? 0.2 : 0.1) : 'transparent', color: active ? md3.secondary : md3.onSurfaceVariant, border: `1px ${state === 'some' ? 'dashed' : 'solid'} ${active ? md3.secondary : md3.outlineVariant}` }} />
          )
        })}
        {value.size > 0 && <Chip label={t('common.clear')} size="small" onDelete={clear} sx={{ color: md3.outline }} />}
        {value.size > 0 && (
          <Tooltip title={t('packets.localOnlyHint')}>
            <Chip size="small" clickable onClick={() => onLockChange(!lock)}
              icon={lock ? <LockIcon sx={{ fontSize: 13 }} /> : <LockOpenIcon sx={{ fontSize: 13 }} />}
              label={t('packets.localOnly')}
              sx={{ ml: 0.5, background: lock ? alpha(md3.tertiary, 0.2) : 'transparent', color: lock ? md3.tertiary : md3.onSurfaceVariant, border: `1px solid ${lock ? md3.tertiary : md3.outlineVariant}`, '& .MuiChip-icon': { color: 'inherit' } }} />
          </Tooltip>
        )}
      </Box>
      {expanded && subCodes.length > 1 && (
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.5, mt: 0.75, ml: showLabel ? 5 : 0, pl: 1, borderLeft: `2px solid ${alpha(md3.secondary, 0.3)}` }}>
          {subCodes.map(code => {
            const on = value.has(code)
            return (
              <Chip key={code} size="small" clickable onClick={() => toggleRegion(code)}
                label={<Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><IataFlag iata={code} size={11} />{code}</Box>}
                sx={{ background: on ? alpha(md3.secondary, 0.2) : 'transparent', color: on ? md3.secondary : md3.onSurfaceVariant, border: `1px solid ${on ? md3.secondary : md3.outlineVariant}` }} />
            )
          })}
        </Box>
      )}
    </Box>
  )
}
