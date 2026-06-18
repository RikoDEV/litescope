import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const dist = resolve(root, 'dist')
const seoSource = readFileSync(resolve(root, 'src/seo.ts'), 'utf-8')

const siteUrl = (
  process.env.VITE_SITE_URL ||
  process.env.SITE_URL ||
  process.env.CF_PAGES_URL ||
  ''
).replace(/\/+$/, '')

const pages = [...seoSource.matchAll(/path:\s*'([^']+)'\s*,[\s\S]*?priority:\s*([0-9.]+)/g)]
  .map(([, path, priority]) => ({ path, priority }))

if (pages.length === 0) {
  throw new Error('No SEO pages found in src/seo.ts')
}

const today = new Date().toISOString().slice(0, 10)
const escapeXml = value => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;')

const urlFor = path => `${siteUrl}${path === '/' ? '/' : path}`

const sitemap = siteUrl ? `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(page => `  <url>
    <loc>${escapeXml(urlFor(page.path))}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${page.priority}</priority>
  </url>`).join('\n')}
</urlset>
` : ''

const robots = `User-agent: *
Allow: /
${siteUrl ? `\nSitemap: ${siteUrl}/sitemap.xml\n` : ''}
`.replace(/\n+$/, '\n')

mkdirSync(dist, { recursive: true })
if (siteUrl) writeFileSync(resolve(dist, 'sitemap.xml'), sitemap)
writeFileSync(resolve(dist, 'robots.txt'), robots)
