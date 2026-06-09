const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPE[ch])
}
