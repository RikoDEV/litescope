import { describe, expect, it } from 'vitest'
import { parseMarkdownLite } from './markdownLite'

describe('parseMarkdownLite', () => {
  it('parses headings of all three levels', () => {
    expect(parseMarkdownLite('# H1\n## H2\n### H3')).toEqual([
      { type: 'h1', text: 'H1' },
      { type: 'h2', text: 'H2' },
      { type: 'h3', text: 'H3' },
    ])
  })

  it('parses unordered lists with either bullet marker', () => {
    expect(parseMarkdownLite('- one\n* two\n-   three')).toEqual([
      { type: 'ul', items: ['one', 'two', 'three'] },
    ])
  })

  it('joins consecutive non-blank lines into a single paragraph', () => {
    expect(parseMarkdownLite('line one\nline two\n\nline three')).toEqual([
      { type: 'p', text: 'line one line two' },
      { type: 'p', text: 'line three' },
    ])
  })

  it('skips blank lines and normalizes CRLF', () => {
    expect(parseMarkdownLite('\r\n# Title\r\n\r\ntext\r\n')).toEqual([
      { type: 'h1', text: 'Title' },
      { type: 'p', text: 'text' },
    ])
  })

  it('breaks a paragraph when a heading or list follows', () => {
    expect(parseMarkdownLite('para text\n# Heading\n- item')).toEqual([
      { type: 'p', text: 'para text' },
      { type: 'h1', text: 'Heading' },
      { type: 'ul', items: ['item'] },
    ])
  })

  it('returns an empty array for empty input', () => {
    expect(parseMarkdownLite('')).toEqual([])
    expect(parseMarkdownLite('   \n  \n')).toEqual([])
  })
})
