const REPO = 'https://github.com/RikoDEV/litescope'
const APP_VERSION = `v${__APP_VERSION__}`

export function buildIssueUrl(error?: Error): string {
  const title = error
    ? `Bug: ${error.name}: ${error.message.slice(0, 80)}`
    : 'Bug report'

  const stack = error?.stack
    ? error.stack.slice(0, 1200)
    : ''

  const body = [
    '## Bug Report',
    '',
    `**App version:** ${APP_VERSION}`,
    `**URL:** ${window.location.href}`,
    `**Browser:** ${navigator.userAgent}`,
    '',
    ...(error ? [
      '## Error',
      '```',
      `${error.name}: ${error.message}`,
      ...(stack ? [stack] : []),
      '```',
      '',
    ] : []),
    '## Steps to reproduce',
    '1. ',
    '2. ',
    '3. ',
    '',
    '## Expected behavior',
    '<!-- What should have happened? -->',
    '',
    '## Actual behavior',
    '<!-- What actually happened? -->',
  ].join('\n')

  return `${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=bug`
}
