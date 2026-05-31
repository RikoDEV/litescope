import { createTheme, alpha, type Theme } from '@mui/material/styles'

// ── MD3 color roles (seed #6750A4) ───────────────────────────────────────────

export type Md3Palette = {
  primary: string; onPrimary: string; primaryContainer: string; onPrimaryContainer: string
  secondary: string; onSecondary: string; secondaryContainer: string; onSecondaryContainer: string
  tertiary: string; onTertiary: string; tertiaryContainer: string; onTertiaryContainer: string
  error: string; onError: string; errorContainer: string; onErrorContainer: string
  background: string; onBackground: string; surface: string; onSurface: string
  surfaceVariant: string; onSurfaceVariant: string
  surfaceContainerLowest: string; surfaceContainerLow: string; surfaceContainer: string
  surfaceContainerHigh: string; surfaceContainerHighest: string
  outline: string; outlineVariant: string
  inverseSurface: string; inverseOnSurface: string; inversePrimary: string; scrim: string
}

export const md3Dark: Md3Palette = {
  primary: '#D0BCFF', onPrimary: '#21005D', primaryContainer: '#4F378B', onPrimaryContainer: '#EADDFF',
  secondary: '#CCC2DC', onSecondary: '#332D41', secondaryContainer: '#4A4458', onSecondaryContainer: '#E8DEF8',
  tertiary: '#EFB8C8', onTertiary: '#492532', tertiaryContainer: '#633B48', onTertiaryContainer: '#FFD8E4',
  error: '#F2B8B5', onError: '#601410', errorContainer: '#8C1D18', onErrorContainer: '#F9DEDC',
  background: '#141218', onBackground: '#E6E1E5', surface: '#141218', onSurface: '#E6E1E5',
  surfaceVariant: '#49454F', onSurfaceVariant: '#CAC4D0',
  surfaceContainerLowest: '#0F0D13', surfaceContainerLow: '#1D1B20', surfaceContainer: '#211F26',
  surfaceContainerHigh: '#2B2930', surfaceContainerHighest: '#36343B',
  outline: '#938F99', outlineVariant: '#49454F',
  inverseSurface: '#E6E1E5', inverseOnSurface: '#322F37', inversePrimary: '#6650A4', scrim: '#000000',
}

export const md3Light: Md3Palette = {
  primary: '#6750A4', onPrimary: '#FFFFFF', primaryContainer: '#EADDFF', onPrimaryContainer: '#21005D',
  secondary: '#625B71', onSecondary: '#FFFFFF', secondaryContainer: '#E8DEF8', onSecondaryContainer: '#1D192B',
  tertiary: '#7D5260', onTertiary: '#FFFFFF', tertiaryContainer: '#FFD8E4', onTertiaryContainer: '#31111D',
  error: '#B3261E', onError: '#FFFFFF', errorContainer: '#F9DEDC', onErrorContainer: '#410E0B',
  background: '#FEF7FF', onBackground: '#1D1B20', surface: '#FEF7FF', onSurface: '#1D1B20',
  surfaceVariant: '#E7E0EC', onSurfaceVariant: '#49454F',
  surfaceContainerLowest: '#FFFFFF', surfaceContainerLow: '#F7F2FA', surfaceContainer: '#F3EDF7',
  surfaceContainerHigh: '#ECE6F0', surfaceContainerHighest: '#E6E0E9',
  outline: '#79747E', outlineVariant: '#CAC4D0',
  inverseSurface: '#322F35', inverseOnSurface: '#F5EFF7', inversePrimary: '#D0BCFF', scrim: '#000000',
}

declare module '@mui/material/styles' {
  interface Palette { md3: Md3Palette }
  interface PaletteOptions { md3?: Md3Palette }
}

export type ThemeMode = 'light' | 'dark'

export function makeTheme(mode: ThemeMode): Theme {
  const md3 = mode === 'dark' ? md3Dark : md3Light

  return createTheme({
    palette: {
      mode,
      primary:    { main: md3.primary,   dark: md3.primaryContainer,   contrastText: md3.onPrimary },
      secondary:  { main: md3.secondary, dark: md3.secondaryContainer, contrastText: md3.onSecondary },
      error:      { main: md3.error,     dark: md3.errorContainer,     contrastText: md3.onError },
      background: { default: md3.background, paper: md3.surfaceContainer },
      text:       { primary: md3.onSurface, secondary: md3.onSurfaceVariant, disabled: md3.outline },
      divider:    md3.outlineVariant,
      action: {
        hover:    alpha(md3.primary, 0.08),
        selected: alpha(md3.primary, 0.12),
        focus:    alpha(md3.primary, 0.12),
        disabled: alpha(md3.onSurface, 0.38),
      },
      md3,
    },

    typography: {
      fontFamily: '"Roboto","Helvetica Neue",Arial,sans-serif',
      h1: { fontSize: 57, fontWeight: 400, lineHeight: 1.123, letterSpacing: '-0.25px' },
      h2: { fontSize: 45, fontWeight: 400, lineHeight: 1.156, letterSpacing: '0px' },
      h3: { fontSize: 36, fontWeight: 400, lineHeight: 1.222, letterSpacing: '0px' },
      h4: { fontSize: 32, fontWeight: 400, lineHeight: 1.25,  letterSpacing: '0px' },
      h5: { fontSize: 28, fontWeight: 400, lineHeight: 1.286, letterSpacing: '0px' },
      h6: { fontSize: 24, fontWeight: 400, lineHeight: 1.333, letterSpacing: '0px' },
      subtitle1: { fontSize: 22, fontWeight: 400, lineHeight: 1.273, letterSpacing: '0px' },
      subtitle2: { fontSize: 16, fontWeight: 500, lineHeight: 1.5,   letterSpacing: '0.15px' },
      body1:  { fontSize: 16, fontWeight: 400, lineHeight: 1.5,   letterSpacing: '0.5px' },
      body2:  { fontSize: 14, fontWeight: 400, lineHeight: 1.429, letterSpacing: '0.25px' },
      caption:   { fontSize: 12, fontWeight: 400, lineHeight: 1.333, letterSpacing: '0.4px' },
      overline:  { fontSize: 11, fontWeight: 500, lineHeight: 1.455, letterSpacing: '0.5px', textTransform: 'uppercase' },
      button:    { fontSize: 14, fontWeight: 500, lineHeight: 1.428, letterSpacing: '0.1px', textTransform: 'none' },
    },

    shape: { borderRadius: 12 },

    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            background: md3.background,
            color: md3.onSurface,
            scrollbarColor: `${md3.outlineVariant} ${md3.surfaceContainerLow}`,
            '&::-webkit-scrollbar': { width: 8, height: 8 },
            '&::-webkit-scrollbar-track': { background: md3.surfaceContainerLow },
            '&::-webkit-scrollbar-thumb': { background: md3.outlineVariant, borderRadius: 4 },
          },
        },
      },

      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: {
            borderRadius: 50,
            padding: '10px 24px',
            fontWeight: 500,
            transition: 'all 0.2s cubic-bezier(0.2, 0, 0, 1)',
            '&:hover': { transform: 'scale(1.02)' },
            '&:active': { transform: 'scale(0.98)' },
          },
          contained: {
            background: md3.primary,
            color: md3.onPrimary,
            '&:hover': { background: md3.primary, filter: 'brightness(0.92)' },
          },
          outlined: {
            borderColor: md3.outline,
            color: md3.primary,
            '&:hover': { borderColor: md3.primary, background: alpha(md3.primary, 0.08) },
          },
          text: {
            color: md3.primary,
            '&:hover': { background: alpha(md3.primary, 0.08) },
          },
        },
      },

      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            fontWeight: 500,
            fontSize: 13,
            height: 32,
            transition: 'all 0.15s cubic-bezier(0.2, 0, 0, 1)',
            '&:hover': { filter: 'brightness(1.1)' },
          },
          filled: {
            background: md3.secondaryContainer,
            color: md3.onSecondaryContainer,
          },
        },
      },

      MuiCard: {
        styleOverrides: {
          root: {
            background: md3.surfaceContainerLow,
            backgroundImage: 'none',
            borderRadius: 16,
            border: `1px solid ${md3.outlineVariant}`,
            transition: 'transform 0.2s cubic-bezier(0.2, 0, 0, 1), box-shadow 0.2s',
          },
        },
      },

      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none', background: md3.surfaceContainer },
          elevation1: { background: md3.surfaceContainerLow },
          elevation2: { background: md3.surfaceContainer },
          elevation3: { background: md3.surfaceContainerHigh },
        },
      },

      MuiTextField: {
        defaultProps: { variant: 'outlined', size: 'small' },
        styleOverrides: {
          root: {
            '& .MuiOutlinedInput-root': {
              borderRadius: 12,
              background: md3.surfaceContainerHighest,
              '& fieldset': { borderColor: md3.outlineVariant },
              '&:hover fieldset': { borderColor: md3.outline },
              '&.Mui-focused fieldset': { borderColor: md3.primary },
            },
            '& .MuiInputLabel-root': { color: md3.onSurfaceVariant },
            '& .MuiOutlinedInput-input': { color: md3.onSurface },
          },
        },
      },

      MuiSelect: {
        styleOverrides: {
          root: {
            borderRadius: 12,
            background: md3.surfaceContainerHighest,
            color: md3.onSurface,
            '& .MuiOutlinedInput-notchedOutline': { borderColor: md3.outlineVariant },
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: md3.outline },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: md3.primary },
          },
        },
      },

      MuiTableHead: {
        styleOverrides: {
          root: {
            '& .MuiTableCell-head': {
              background: md3.surfaceContainerHighest,
              color: md3.onSurfaceVariant,
              fontWeight: 600,
              fontSize: 11,
              letterSpacing: '0.8px',
              textTransform: 'uppercase',
              borderBottom: `1px solid ${md3.outlineVariant}`,
            },
          },
        },
      },

      MuiTableRow: {
        styleOverrides: {
          root: {
            cursor: 'pointer',
            transition: 'background 0.12s',
            '&:hover': { background: alpha(md3.primary, 0.05) },
            '&.Mui-selected': { background: alpha(md3.primary, 0.12) },
            '&.Mui-selected:hover': { background: alpha(md3.primary, 0.16) },
            '& .MuiTableCell-root': {
              borderBottom: `1px solid ${alpha(md3.outlineVariant, 0.4)}`,
              color: md3.onSurface,
            },
          },
        },
      },

      MuiTableCell: {
        styleOverrides: { root: { fontSize: 13, padding: '8px 12px' } },
      },

      MuiTab: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            fontWeight: 500,
            fontSize: 14,
            letterSpacing: '0.1px',
            color: md3.onSurfaceVariant,
            minHeight: 48,
            '&.Mui-selected': { color: md3.primary },
          },
        },
      },

      MuiTabs: {
        styleOverrides: {
          indicator: { background: md3.primary, height: 3, borderRadius: '3px 3px 0 0' },
          root: { borderBottom: `1px solid ${md3.outlineVariant}` },
        },
      },

      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            background: md3.inverseSurface,
            color: md3.inverseOnSurface,
            fontSize: 12,
            borderRadius: 8,
            padding: '6px 12px',
          },
        },
      },

      MuiLinearProgress: {
        styleOverrides: {
          root: { borderRadius: 4, background: md3.secondaryContainer },
          bar: { background: md3.primary, borderRadius: 4 },
        },
      },

      MuiDivider: {
        styleOverrides: { root: { borderColor: md3.outlineVariant } },
      },

      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 50,
            margin: '2px 8px',
            transition: 'all 0.15s cubic-bezier(0.2, 0, 0, 1)',
            '&:hover': { background: alpha(md3.onSurface, 0.08) },
            '&.Mui-selected': {
              background: md3.secondaryContainer,
              color: md3.onSecondaryContainer,
              '&:hover': { background: md3.secondaryContainer, filter: 'brightness(1.05)' },
            },
          },
        },
      },

      MuiToggleButton: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            color: md3.onSurfaceVariant,
            borderColor: md3.outlineVariant,
            '&.Mui-selected': {
              background: alpha(md3.primary, 0.15),
              color: md3.primary,
              '&:hover': { background: alpha(md3.primary, 0.22) },
            },
          },
        },
      },

      MuiFab: {
        styleOverrides: {
          root: {
            background: `linear-gradient(135deg, ${md3.primaryContainer}, ${md3.tertiaryContainer})`,
            color: md3.onPrimaryContainer,
            boxShadow: `0 3px 12px ${alpha(md3.primary, 0.35)}`,
            '&:hover': {
              background: `linear-gradient(135deg, ${md3.primaryContainer}, ${md3.tertiaryContainer})`,
              filter: 'brightness(1.08)',
              boxShadow: `0 6px 20px ${alpha(md3.primary, 0.45)}`,
              transform: 'scale(1.04)',
            },
            transition: 'all 0.2s cubic-bezier(0.2, 0, 0, 1)',
          },
        },
      },

      MuiBadge: {
        styleOverrides: {
          badge: { background: md3.primary, color: md3.onPrimary, fontSize: 10, fontWeight: 700 },
        },
      },

      MuiMenu: {
        styleOverrides: {
          paper: { background: md3.surfaceContainerHigh, borderRadius: 12, border: `1px solid ${md3.outlineVariant}` },
        },
      },

      MuiAlert: {
        styleOverrides: { root: { borderRadius: 12 } },
      },
    },
  })
}

export default makeTheme('dark')
