// Minimal, dependency-free Markdown subset for operator-supplied privacy.md
// overrides: headings (# / ## / ###), paragraphs, and unordered lists (-/*).
// No inline formatting or HTML — keeps the renderer simple and injection-safe.

export type MarkdownBlock =
  | { type: 'h1' | 'h2' | 'h3'; text: string }
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }

export function parseMarkdownLite(md: string): MarkdownBlock[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (!line.trim()) { i++; continue }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ type: `h${heading[1]!.length}` as 'h1' | 'h2' | 'h3', text: heading[2]!.trim() })
      i++
      continue
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^[-*]\s+/, '').trim())
        i++
      }
      blocks.push({ type: 'ul', items })
      continue
    }

    const para: string[] = []
    while (i < lines.length && (lines[i] ?? '').trim() && !/^(#{1,3})\s+/.test(lines[i] ?? '') && !/^[-*]\s+/.test(lines[i] ?? '')) {
      para.push((lines[i] ?? '').trim())
      i++
    }
    blocks.push({ type: 'p', text: para.join(' ') })
  }

  return blocks
}
