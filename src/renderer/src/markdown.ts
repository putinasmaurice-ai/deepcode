import MarkdownIt from 'markdown-it'

// Real CommonMark/GFM-ish rendering (ordered/nested lists, blockquotes, tables,
// strikethrough, inline code in bold, etc.) replacing the old regex renderer.
// html:false blocks raw-HTML injection (XSS-safe); the syntax highlighting +
// copy buttons are still applied post-render by useCodeEnhancer in MessageView.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
})

// External links open in the system browser (handled by the window-open handler).
const defaultLinkOpen =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const t = tokens[idx]
  t.attrSet('target', '_blank')
  t.attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

export function renderMarkdown(src: string): string {
  return md.render(src || '')
}
