import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type { PreviewInfo } from '@shared/api'

// Best-effort guess of what to show in the preview pane for a project directory:
// a built static index.html (loadable immediately via file://), or a dev server
// the user can start. Mirrors how Claude Code surfaces a live preview.

// Built outputs render fine over file://; the project ROOT index.html does not
// for a bundler SPA (it references /src/main.tsx), so it's only a last resort.
const BUILT_CANDIDATES = ['dist/index.html', 'build/index.html', 'out/index.html', 'public/index.html']

interface Pkg {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function frameworkPort(deps: Record<string, string>): number | null {
  if (deps.vite || deps['@vitejs/plugin-react']) return 5173
  if (deps.next) return 3000
  if (deps['react-scripts']) return 3000
  if (deps['@vue/cli-service']) return 8080
  if (deps['@angular/cli']) return 4200
  return null // not a recognized dev-server framework
}

export function detectPreview(cwd: string): PreviewInfo {
  if (!cwd || !existsSync(cwd)) return { url: null, kind: 'none', devScript: null }

  let devScript: string | null = null
  let fwPort: number | null = null
  const pkgPath = join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Pkg & { scripts?: Record<string, string> }
      const scripts: Record<string, string> = pkg.scripts ?? {}
      const name = ['dev', 'start', 'serve', 'preview'].find((s) => scripts[s])
      if (name) devScript = `npm run ${name}`
      fwPort = frameworkPort({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })
    } catch {
      /* ignore malformed package.json */
    }
  }

  // A real framework dev server is the live-preview target — its root index.html is
  // a bundler template that renders blank over file://. Only classify 'dev' when we
  // actually recognize the framework (so a generic `serve`/`start` script doesn't
  // get mislabeled and pointed at a port that never comes up).
  if (devScript && fwPort !== null) {
    return { url: `http://localhost:${fwPort}`, kind: 'dev', devScript }
  }

  // Otherwise prefer an existing built/static index.html (loads immediately).
  for (const rel of [...BUILT_CANDIDATES, 'index.html']) {
    const p = join(cwd, rel)
    if (existsSync(p)) return { url: pathToFileURL(p).href, kind: 'static', devScript }
  }

  // A dev/serve script with no framework + no static build: best-effort dev URL.
  if (devScript) return { url: 'http://localhost:3000', kind: 'dev', devScript }
  return { url: null, kind: 'none', devScript: null }
}
