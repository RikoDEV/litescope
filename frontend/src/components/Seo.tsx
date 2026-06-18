import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { DEFAULT_DESCRIPTION, DEFAULT_TITLE, SITE_NAME, seoForPath } from '../seo'

const setMeta = (selector: string, attr: 'content' | 'href', value: string) => {
  const el = document.head.querySelector(selector)
  if (el) el.setAttribute(attr, value)
}

export default function Seo() {
  const loc = useLocation()

  useEffect(() => {
    const page = seoForPath(loc.pathname)
    const title = page.title || DEFAULT_TITLE
    const description = page.description || DEFAULT_DESCRIPTION
    const canonical = new URL(page.path, window.location.origin).toString()
    const image = new URL('/og-image.png', window.location.origin).toString()

    document.title = title
    setMeta('meta[name="description"]', 'content', description)
    setMeta('meta[property="og:title"]', 'content', title)
    setMeta('meta[property="og:description"]', 'content', description)
    setMeta('meta[property="og:url"]', 'content', canonical)
    setMeta('meta[property="og:image"]', 'content', image)
    setMeta('meta[name="twitter:title"]', 'content', title)
    setMeta('meta[name="twitter:description"]', 'content', description)
    setMeta('meta[name="twitter:image"]', 'content', image)
    setMeta('link[rel="canonical"]', 'href', canonical)
    setMeta('meta[name="application-name"]', 'content', SITE_NAME)
  }, [loc.pathname])

  return null
}
