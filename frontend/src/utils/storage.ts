// Centralized localStorage key names and typed accessors. Keeping the key
// strings in one place prevents drift (e.g. the channel-keys store is read by
// both the Channels page and the Decoder page).

export const LS_KEYS = {
  channelKeys: 'litescope-channel-keys',
  channelSeen: 'litescope-channel-seen',
  channelHashNames: 'litescope-channel-hash-names',
  channelStackDuplicates: 'litescope-channel-stack',
  channelsCombined: 'litescope-channels-combined',
  themeMode: 'litescope-theme-mode',
  themeAccent: 'litescope-theme-accent',
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

// Channel hashes are a single byte, so the server can only label a channel by
// its hex hash unless it decrypted a message itself. Once we decrypt a channel
// client-side we learn its name; we persist the hash→name mapping here so the
// name survives channel-list refetches (e.g. the visibility refresh) and page
// reloads, instead of reverting to the hex hash.
export function loadChannelHashNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEYS.channelHashNames) ?? '{}')
  } catch {
    return {}
  }
}

export function saveChannelHashNames(map: Record<string, string>): void {
  localStorage.setItem(LS_KEYS.channelHashNames, JSON.stringify(map))
}

// The set of channel hashes the user has chosen to merge into the "combined"
// pseudo-channel. Persisted so the combination survives navigating away and
// page reloads instead of having to be rebuilt every time.
export function loadCombinedHashes(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_KEYS.channelsCombined) ?? '[]')
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export function saveCombinedHashes(hashes: string[]): void {
  localStorage.setItem(LS_KEYS.channelsCombined, JSON.stringify(hashes))
}
