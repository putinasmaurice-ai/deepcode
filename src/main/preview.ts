import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type { PreviewInfo } from '@shared/api'

// Best-effort guess of what to show in the preview pane for a project directory:
// a built static index.html (loadable immediately via file://), or a dev server
// the user can start. Mirrors how Claude Code surfaces a live preview.

const STATIC_CANDIDATES = [
  'index.html',
  'dist/index.html',
  'build/index.html',
  'out/index.html',
  'public/index.html'
]

function devServerPort(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): number {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  if (deps.vite || deps['@vitejs/plugin-react']) return 5173
  if (deps.next) return 3000
  if (deps['react-scripts']) return 3000
  if (deps['@vue/cli-service'] || deps.vue) return 8080
  if (deps['@angular/cli']) return 4200
  return 3000
}

export function detectPreview(cwd: string): PreviewInfo {
  if (!cwd || !existsSync(cwd)) return { url: null, kind: 'none', devScript: null }

  let devScript: string | null = null
  let port = 3000
  const pkgPath = join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const scripts: Record<string, string> = pkg.scripts ?? {}
      const name = ['dev', 'start', 'serve', 'preview'].find((s) => scripts[s])
      if (name) devScript = `npm run ${name}`
      port = devServerPort(pkg)
    } catch {
      /* ignore malformed package.json */
    }
  }

  // A dev script means this is a live SPA project: its root index.html is a
  // bundler template (e.g. <script type="module" src="/src/main.tsx">) that renders
  // blank over file://. Prefer the dev server; the user starts it and hits ⟳.
  if (devScript) return { url: `http://localhost:${port}`, kind: 'dev', devScript }

  // No dev script → a built/plain static site: load its index.html directly.
  for (const rel of STATIC_CANDIDATES) {
    const p = join(cwd, rel)
    if (existsSync(p)) {
      return { url: pathToFileURL(p).href, kind: 'static', devScript }
    }
  }
  return { url: null, kind: 'none', devScript: null }
}
