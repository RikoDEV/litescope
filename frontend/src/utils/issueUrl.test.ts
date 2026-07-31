import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildIssueUrl } from './issueUrl'

describe('buildIssueUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds a generic bug report URL when no error is given', () => {
    vi.stubGlobal('window', { location: { href: 'https://example.com/nodes/abc' } })
    vi.stubGlobal('navigator', { userAgent: 'test-agent' })

    const url = buildIssueUrl()

    expect(url).toContain('https://github.com/RikoDEV/litescope/issues/new?title=')
    expect(url).toContain('labels=bug')

    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('title')).toBe('Bug report')
    const body = params.get('body')!
    expect(body).toContain('**URL:** https://example.com/nodes/abc')
    expect(body).toContain('**Browser:** test-agent')
    expect(body).not.toContain('## Error')
  })

  it('includes error name, message, and truncated stack when an error is given', () => {
    vi.stubGlobal('window', { location: { href: 'https://example.com/' } })
    vi.stubGlobal('navigator', { userAgent: 'test-agent' })

    const err = new Error('a'.repeat(200))
    err.name = 'TypeError'
    err.stack = 'x'.repeat(2000)

    const url = buildIssueUrl(err)
    const params = new URLSearchParams(url.split('?')[1])

    expect(params.get('title')).toBe(`Bug: TypeError: ${'a'.repeat(80)}`)
    const body = params.get('body')!
    expect(body).toContain('## Error')
    expect(body).toContain(`TypeError: ${'a'.repeat(200)}`)
    expect(body).toContain('x'.repeat(1200))
    expect(body).not.toContain('x'.repeat(1201))
  })

  it('omits the stack block when the error has none', () => {
    vi.stubGlobal('window', { location: { href: 'https://example.com/' } })
    vi.stubGlobal('navigator', { userAgent: 'test-agent' })

    const err = new Error('boom')
    err.stack = undefined

    const url = buildIssueUrl(err)
    const body = new URLSearchParams(url.split('?')[1]).get('body')!

    expect(body).toContain('Error: boom')
  })
})
