import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Typography from '@mui/material/Typography'
import Tooltip from '@mui/material/Tooltip'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import NumbersIcon from '@mui/icons-material/Numbers'
import { api } from '../services/api'
import type { Node } from '../types'

const HEX = '0123456789ABCDEF'.split('')
const MAX_TIP_NODES = 5

type CellState = 'empty' | 'taken' | 'possible' | 'collision'

interface SubGroup { prefix: string; nodes: Node[] }
interface Cell {
  hex: string
  reserved: boolean
  state: CellState
  nodes: Node[]
  maxGroup: number
  groups: SubGroup[]
}

// Orange → red gradient keyed on the largest colliding group (2..6+), matching
// the reference palette: 2→rgb(220,120,30) … 6→rgb(255,0,30).
function collisionColor(maxGroup: number): string {
  const c = Math.max(2, Math.min(6, maxGroup))
  const tt = (c - 2) / 4
  return `rgb(${Math.round(220 + tt * 35)}, ${Math.round(120 - tt * 120)}, 30)`
}

export default function HashMatrix() {
  const theme = useTheme()
  const md3 = theme.palette.md3
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [nodes, setNodes] = useState<Node[] | null>(null)
  const [bytes, setBytes] = useState<1 | 2 | 3>(1)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    api.nodes().then(r => setNodes(r.nodes ?? [])).catch(() => setNodes([]))
  }, [])

  const { cells, stats } = useMemo(() => {
    const all = nodes ?? []
    const valid = all.filter(n => n.pubKey && n.pubKey.length >= bytes * 2)

    // Group every node by its full N-byte prefix (collision granularity).
    const groups = new Map<string, Node[]>()
    for (const n of valid) {
      const pfx = n.pubKey.slice(0, bytes * 2).toUpperCase()
      const a = groups.get(pfx)
      if (a) a.push(n)
      else groups.set(pfx, [n])
    }

    // Bucket nodes by their first byte for the 16×16 grid.
    const byFirst = new Map<string, Node[]>()
    for (const n of valid) {
      const fb = n.pubKey.slice(0, 2).toUpperCase()
      const a = byFirst.get(fb)
      if (a) a.push(n)
      else byFirst.set(fb, [n])
    }

    let occupied = 0
    let collisionGroups = 0
    for (const g of groups.values()) if (g.length >= 2) collisionGroups++

    const cells: Cell[] = []
    for (let hi = 0; hi < 16; hi++) {
      for (let lo = 0; lo < 16; lo++) {
        const hex = HEX[hi] + HEX[lo]
        const cellNodes = byFirst.get(hex) ?? []
        const sub = new Map<string, Node[]>()
        for (const n of cellNodes) {
          const pfx = n.pubKey.slice(0, bytes * 2).toUpperCase()
          const a = sub.get(pfx)
          if (a) a.push(n)
          else sub.set(pfx, [n])
        }
        let maxGroup = 0
        for (const g of sub.values()) if (g.length > maxGroup) maxGroup = g.length

        let state: CellState
        if (cellNodes.length === 0) state = 'empty'
        else if (maxGroup >= 2) state = 'collision'
        else if (cellNodes.length >= 2) state = 'possible'
        else state = 'taken'

        if (cellNodes.length > 0) occupied++

        const subGroups = [...sub.entries()]
          .map(([prefix, ns]) => ({ prefix, nodes: ns }))
          .sort((a, b) => b.nodes.length - a.nodes.length)

        cells.push({ hex, reserved: hex === '00' || hex === 'FF', state, nodes: cellNodes, maxGroup, groups: subGroups })
      }
    }

    return {
      cells,
      stats: {
        tracked: all.filter(n => n.pubKey).length,
        distinct: groups.size,
        spacePct: (occupied / 256) * 100,
        collisions: collisionGroups,
      },
    }
  }, [nodes, bytes])

  const cellByHex = useMemo(() => new Map(cells.map(c => [c.hex, c])), [cells])
  const active = selected ? cellByHex.get(selected) ?? null : null

  const cellBg = (c: Cell): string => {
    switch (c.state) {
      case 'collision': return collisionColor(c.maxGroup)
      case 'possible':  return alpha('#f59e0b', 0.2)
      default:          return 'transparent'
    }
  }
  const cellFg = (c: Cell): string => {
    if (c.state === 'collision') return '#fff'
    if (c.state === 'empty')     return md3.outline
    return md3.onSurfaceVariant
  }

  const statusText = (c: Cell): string => {
    switch (c.state) {
      case 'collision': return t('analytics.hashMatrixCollisionStatus', { count: c.nodes.length })
      case 'possible':  return t('analytics.hashMatrixPossible', { count: c.nodes.length })
      case 'taken':     return t('analytics.hashMatrixOneNode')
      default:          return t('analytics.hashMatrixAvailable')
    }
  }

  const statCards = [
    { l: t('analytics.hashMatrixNodesTracked'), v: stats.tracked.toLocaleString(), c: md3.primary },
    { l: t('analytics.hashMatrixUsingId', { bytes }), v: stats.distinct.toLocaleString(), c: '#14b8a6' },
    { l: t('analytics.hashMatrixSpaceUsed'), v: `${stats.spacePct.toFixed(1)}%`, sub: t('analytics.hashMatrixOf256'), c: '#f59e0b' },
    { l: t('analytics.hashMatrixCollisionsStat'), v: stats.collisions.toLocaleString(), c: md3.error },
  ]

  return (
    <Card>
      <CardContent>
        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1.5 }}>
          <Box sx={{ width: 26, height: 26, borderRadius: 1.5, background: alpha(md3.primary, 0.12), display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <NumbersIcon sx={{ fontSize: 16, color: md3.primary }} />
          </Box>
          <Typography variant="subtitle2" sx={{ color: md3.onSurfaceVariant }}>
            {t('analytics.hashMatrixTitle', { bytes })}
          </Typography>
        </Box>

        {/* Byte selector + description */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 1.5 }}>
          <ToggleButtonGroup
            size="small" exclusive value={bytes}
            onChange={(_, v) => { if (v) { setBytes(v); setSelected(null) } }}
          >
            {[1, 2, 3].map(n => (
              <ToggleButton key={n} value={n} sx={{ px: 1.5, py: 0.25, fontSize: 12, textTransform: 'none' }}>
                {n}-Byte
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Typography variant="caption" sx={{ color: md3.onSurfaceVariant }}>
            {t('analytics.hashMatrixDesc', { bytes })}
          </Typography>
        </Box>

        {/* Grid + side column (stats + detail) */}
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <Box sx={{ overflowX: 'auto' }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: `20px repeat(16, 30px)`, gap: '2px', fontFamily: 'monospace' }}>
              {/* column headers */}
              <Box />
              {HEX.map(h => (
                <Box key={`col-${h}`} sx={{ textAlign: 'center', fontSize: 11, fontWeight: 700, color: md3.outline }}>{h}</Box>
              ))}
              {/* rows */}
              {HEX.map((rh, ri) => (
                <Box key={`row-${rh}`} sx={{ display: 'contents' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', pr: 0.5, fontSize: 11, fontWeight: 700, color: md3.outline }}>{rh}</Box>
                  {HEX.map((_, ci) => {
                    const c = cells[ri * 16 + ci]
                    const clickable = c.nodes.length > 0
                    return (
                      <Tooltip
                        key={c.hex}
                        arrow
                        title={
                          <Box sx={{ fontSize: 11 }}>
                            <Box sx={{ fontWeight: 700, fontFamily: 'monospace' }}>0x{c.hex}</Box>
                            <Box sx={{ opacity: 0.85 }}>{statusText(c)}</Box>
                            {c.reserved && <Box sx={{ opacity: 0.7, mt: 0.25 }}>{t('analytics.hashMatrixReserved')}</Box>}
                            {c.nodes.slice(0, MAX_TIP_NODES).map((n, i) => (
                              <Box key={i} sx={{ mt: i === 0 ? 0.5 : 0 }}>{n.name || n.pubKey.slice(0, 12)}</Box>
                            ))}
                            {c.nodes.length > MAX_TIP_NODES && (
                              <Box sx={{ opacity: 0.7 }}>{t('analytics.hashMatrixMore', { count: c.nodes.length - MAX_TIP_NODES })}</Box>
                            )}
                          </Box>
                        }
                      >
                        <Box
                          onClick={clickable ? () => setSelected(c.hex) : undefined}
                          sx={{
                            width: 30, height: 30,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 11, fontWeight: c.state === 'collision' ? 700 : 400,
                            color: cellFg(c),
                            background: cellBg(c),
                            border: c.reserved ? `1px dashed ${md3.outline}` : `1px solid ${md3.outlineVariant}`,
                            borderRadius: 0.5,
                            cursor: clickable ? 'pointer' : 'default',
                            opacity: c.reserved && c.state === 'empty' ? 0.5 : 1,
                            outline: selected === c.hex ? `2px solid ${md3.primary}` : 'none',
                            outlineOffset: '-1px',
                          }}
                        >
                          {c.hex}
                        </Box>
                      </Tooltip>
                    )
                  })}
                </Box>
              ))}
            </Box>

            {/* legend */}
            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 1.5, fontSize: 11, color: md3.onSurfaceVariant }}>
              {[
                { l: t('analytics.hashMatrixAvailable'), bg: 'transparent', border: `1px solid ${md3.outlineVariant}` },
                { l: t('analytics.hashMatrixLegOneNode'), bg: 'transparent', border: `1px solid ${md3.outline}` },
                { l: t('analytics.hashMatrixLegPossible'), bg: alpha('#f59e0b', 0.2), border: 'none' },
                { l: t('analytics.hashMatrixLegCollision'), bg: collisionColor(4), border: 'none' },
                { l: t('analytics.hashMatrixLegReserved'), bg: 'transparent', border: `1px dashed ${md3.outline}` },
              ].map(s => (
                <Box key={s.l} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Box sx={{ width: 12, height: 12, borderRadius: 0.5, background: s.bg, border: s.border }} />
                  {s.l}
                </Box>
              ))}
            </Box>
          </Box>

          {/* side column: stat cards + detail, fills the space right of the grid */}
          <Box sx={{ flex: '1 1 260px', minWidth: 240, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {/* stat cards */}
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1.5 }}>
              {statCards.map(p => (
                <Box key={p.l} sx={{ px: 1.5, py: 1, borderRadius: 2, minWidth: 0, background: alpha(p.c, 0.1), border: `1px solid ${alpha(p.c, 0.25)}` }}>
                  <Typography variant="caption" sx={{ color: md3.onSurfaceVariant, display: 'block', mb: 0.25 }}>{p.l}</Typography>
                  <Typography variant="body2" sx={{ color: p.c, fontWeight: 700 }}>{p.v}</Typography>
                  {p.sub && <Typography sx={{ fontSize: 10, color: md3.outline }}>{p.sub}</Typography>}
                </Box>
              ))}
            </Box>

            {/* detail panel */}
            <Box>
            {!active ? (
              <Typography variant="caption" sx={{ color: md3.outline }}>{t('analytics.hashMatrixSelectPrompt')}</Typography>
            ) : (
              <Box>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.5 }}>
                  <Typography sx={{ fontFamily: 'monospace', fontWeight: 700, color: md3.onSurface }}>0x{active.hex}</Typography>
                  <Typography variant="caption" sx={{ color: active.state === 'collision' ? md3.error : md3.onSurfaceVariant }}>
                    {statusText(active)}
                  </Typography>
                </Box>
                {active.reserved && (
                  <Typography sx={{ fontSize: 11, color: md3.outline, mb: 0.5 }}>{t('analytics.hashMatrixReserved')}</Typography>
                )}
                {active.groups.map(g => (
                  <Box key={g.prefix} sx={{ mb: 0.75 }}>
                    {bytes > 1 && (
                      <Typography sx={{ fontFamily: 'monospace', fontSize: 10, color: md3.outline }}>
                        0x{g.prefix}{g.nodes.length >= 2 ? ` · ${g.nodes.length}×` : ''}
                      </Typography>
                    )}
                    {g.nodes.map(n => (
                      <Box
                        key={n.pubKey}
                        onClick={() => navigate(`/nodes/${encodeURIComponent(n.pubKey)}`)}
                        sx={{
                          display: 'flex', alignItems: 'center', gap: 0.75, py: 0.25, px: 0.5, borderRadius: 1, cursor: 'pointer',
                          '&:hover': { background: alpha(md3.primary, 0.08) },
                        }}
                      >
                        <Box sx={{ width: 6, height: 6, borderRadius: '50%', background: g.nodes.length >= 2 ? collisionColor(g.nodes.length) : md3.outline, flexShrink: 0 }} />
                        <Typography sx={{ fontSize: 12, color: md3.onSurface, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {n.name || n.pubKey.slice(0, 12)}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                ))}
              </Box>
            )}
            </Box>
          </Box>
        </Box>
      </CardContent>
    </Card>
  )
}
