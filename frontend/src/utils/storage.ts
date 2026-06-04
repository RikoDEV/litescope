// Centralized localStorage key names and typed accessors. Keeping the key
// strings in one place prevents drift (e.g. the channel-keys store is read by
// both the Channels page and the Decoder page).

export const LS_KEYS = {
  channelKeys: 'litescope-channel-keys',
  channelSeen: 'litescope-channel-seen',
  themeMode: 'litescope-theme-mode',
  themeAccent: 'litescope-theme-accent',
  cookieConsent: 'litescope-cookie-consent',
} as const

// NOTE: channel decryption keys live in plaintext localStorage. They are
// user-supplied, client-only, and low value, but are therefore exposed to any
// XSS on the origin — do not store anything more sensitive here.
export interface ChannelKey { name: string; key: string; derived?: boolean }

export function loadChannelKeys(): ChannelKey[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEYS.channelKeys) ?? '[]')
  } catch {
    return []
  }
}

export function saveChannelKeys(keys: ChannelKey[]): void {
  localStorage.setItem(LS_KEYS.channelKeys, JSON.stringify(keys))
}
