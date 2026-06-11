import { describe, expect, it } from 'vitest'
import { escapeHtml } from './html'

describe('escapeHtml', () => {
  it('escapes special HTML characters and handles nullish input', () => {
    expect(escapeHtml(`<a href="x&y">'ok'</a>`)).toBe('&lt;a href=&quot;x&amp;y&quot;&gt;&#39;ok&#39;&lt;/a&gt;')
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })
})
