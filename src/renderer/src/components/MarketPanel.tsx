import { useEffect, useMemo, useState } from 'react'
import type { McpServerDef } from '../../../shared/types'

const api = window.deepcode

interface CatalogEntry {
  name: string
  desc: string
  command: string
  args: string[]
  category: string
  note?: string // shown when the server needs an env/secret or a prerequisite
}

// Curated, install-ready MCP connectors. 1-click activate writes the entry into mcp.json and
// connects it. Servers needing a token/env get a `note` (set the value in MCP / Connectors).
const MCP_CATALOG: CatalogEntry[] = [
  // ── Code-Intelligenz ──
  { name: 'serena', category: 'Code-Intelligenz', command: 'uvx', args: ['--from', 'git+https://github.com/oraios/serena', 'serena', 'start-mcp-server'], desc: 'Semantische Symbol-Navigation/Refactoring über 40+ Sprachen via LSP (find/rename Symbol, Referenzen). Echte Code-Intelligenz statt Text-Grep.', note: 'Braucht uv/Python. Bündelt Language-Server, kein Key.' },
  { name: 'ast-grep', category: 'Code-Intelligenz', command: 'uvx', args: ['--from', 'git+https://github.com/ast-grep/ast-grep-mcp', 'ast-grep-server'], desc: 'Strukturelle (AST-Pattern) Code-Suche + Lint-Regeln über viele Sprachen — findet Code nach Form, nicht Regex.', note: 'Braucht ast-grep-CLI: npm i -g @ast-grep/cli' },
  { name: 'repomix', category: 'Code-Intelligenz', command: 'npx', args: ['-y', 'repomix@latest', '--mcp'], desc: 'Packt ein ganzes Repo in EINE token-budgetierte Datei (XML/MD) — gibt dem Modell Whole-Repo-Kontext auf einen Schlag.' },
  // ── Wissen / RAG ──
  { name: 'context7', category: 'Wissen / Docs', command: 'npx', args: ['-y', '@upstash/context7-mcp'], desc: 'Spielt aktuelle, versions-korrekte Library-Docs + richtige Code-Snippets on-demand ein — stoppt halluzinierte APIs.', note: 'Optional CONTEXT7_API_KEY (gratis) für höhere Limits — funktioniert auch keyless.' },
  { name: 'chroma', category: 'Wissen / RAG', command: 'uvx', args: ['chroma-mcp', '--client-type', 'persistent', '--data-dir', './chroma-data'], desc: 'Lokale persistente Vektor-DB (Embeddings, Vektor-Suche, Volltext + Metadaten) — projekt-gescopte RAG.', note: 'Braucht uv; Datenordner auf Platte.' },
  { name: 'local-rag', category: 'Wissen / RAG', command: 'npx', args: ['-y', 'mcp-local-rag'], desc: 'Privacy-first lokale RAG über einen Docs-Ordner: hybride semantische + Keyword-Suche, On-Device-Embeddings.', note: 'BASE_DIR=<docs> in mcp.json-env setzen.' },
  { name: 'qdrant', category: 'Wissen / RAG', command: 'uvx', args: ['mcp-server-qdrant'], desc: 'Semantisches Gedächtnis über Qdrant (qdrant-store / qdrant-find) — Text+Metadaten als Embeddings.', note: 'QDRANT_LOCAL_PATH, COLLECTION_NAME, EMBEDDING_MODEL in env.' },
  { name: 'basic-memory', category: 'Gedächtnis', command: 'uvx', args: ['basic-memory', 'mcp'], desc: 'Persistente lokale Wissensbasis als Markdown auf der Platte, in SQLite indexiert (Entitäten/Relationen).' },
  // ── Web / Suche / Browser ──
  { name: 'ddg-search', category: 'Web / Suche', command: 'uvx', args: ['duckduckgo-mcp-server'], desc: 'Privacy-freundliche Websuche via DuckDuckGo + Content-Fetch/Parse, mit Rate-Limiting. Kein Key.' },
  { name: 'searxng', category: 'Web / Suche', command: 'npx', args: ['-y', 'mcp-searxng'], desc: 'Private Websuche über eine SearXNG-Metasuche (eigene/öffentliche Instanz).', note: 'SEARXNG_URL=<deine Instanz> in env.' },
  { name: 'brave-search', category: 'Web / Suche', command: 'npx', args: ['-y', '@brave/brave-search-mcp-server'], desc: 'Brave Search (Web/lokal/Bild/Video/News + Summarizer).', note: 'BRAVE_API_KEY (gratis ~2k/Monat, ohne Kreditkarte) in env.' },
  { name: 'chrome-devtools', category: 'Web / Browser', command: 'npx', args: ['chrome-devtools-mcp@latest'], desc: 'Steuert echtes Chrome via DevTools-Protokoll: DOM inspizieren, Console-Logs, Netzwerk, Performance.', note: 'Verbindet sich mit lokalem Chrome (--headless/--slim möglich).' },
  { name: 'fetcher', category: 'Web / Browser', command: 'npx', args: ['-y', 'fetcher-mcp'], desc: 'Headless-Playwright-Fetcher mit Readability: führt JS aus (SPAs!), strippt Werbung/Nav, liefert sauberen Inhalt.', note: 'Lädt beim 1. Start ein Chromium.' },
  // ── Datenbanken ──
  { name: 'postgres', category: 'Datenbanken', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://user:pass@localhost/db'], desc: 'Schema-Introspektion + read-only SELECT gegen Postgres via Connection-String.', note: 'Connection-String in den args anpassen.' },
  { name: 'mysql', category: 'Datenbanken', command: 'npx', args: ['-y', '@benborla29/mcp-server-mysql'], desc: 'MySQL: Abfragen, Insert/Update/Delete, Schema-Ops, konfigurierbare Sicherheit. Gegen lokale/Docker-DB.', note: 'MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASS, MYSQL_DB in env.' },
  { name: 'mongodb', category: 'Datenbanken', command: 'npx', args: ['-y', 'mongodb-mcp-server', '--connectionString', 'mongodb://localhost:27017'], desc: 'MongoDB: Collections abfragen, Aggregationen, Schema/Indizes, CRUD — gegen lokalen mongod.' },
  { name: 'duckdb', category: 'Datenbanken', command: 'uvx', args: ['mcp-server-duckdb', '--db-path', './data.duckdb'], desc: 'DuckDB-SQL lokal — Parquet/CSV/JSON + analytische DBs in-process abfragen (read-only-Flag möglich).' },
  // ── DevOps / VCS ──
  { name: 'docker', category: 'DevOps', command: 'uvx', args: ['docker-mcp'], desc: 'Docker lokal steuern: Container list/run/stop, Images bauen, Logs, Compose — sandboxed Runs.', note: 'Braucht laufenden Docker-Daemon.' },
  { name: 'gitlab', category: 'DevOps', command: 'npx', args: ['-y', '@modelcontextprotocol/server-gitlab'], desc: 'GitLab: Repos, Issues, Merge-Requests via API — auch self-hosted (bleibt privat).', note: 'GITLAB_PERSONAL_ACCESS_TOKEN, optional GITLAB_API_URL in env.' },
  // ── Produktivität / Notizen ──
  { name: 'time', category: 'Produktivität', command: 'uvx', args: ['mcp-server-time'], desc: 'Aktuelle Zeit + IANA-Zeitzonen-Umrechnung; erkennt die System-TZ. Winzig, kein Key.' },
  { name: 'notion', category: 'Produktivität', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], desc: 'Notion: Seiten/Datenbanken/Blocks suchen/lesen/anlegen/ändern — lokal über deinen Integration-Token.', note: 'NOTION_TOKEN=ntn_… in env.' },
  { name: 'todoist', category: 'Produktivität', command: 'npx', args: ['-y', '@abhiz123/todoist-mcp-server'], desc: 'Aufgaben per natürlicher Sprache: anlegen/listen/abschließen nach Priorität/Datum/Projekt.', note: 'TODOIST_API_TOKEN (gratis) in env.' },
  { name: 'obsidian', category: 'Produktivität', command: 'uvx', args: ['mcp-obsidian'], desc: 'Lokalen Obsidian-Vault lesen/schreiben/durchsuchen (Notizen, Tags, Frontmatter).', note: 'Obsidian „Local REST API"-Plugin + OBSIDIAN_API_KEY in env.' },
  // ── bereits eingebaut (Referenz-Server) ──
  { name: 'filesystem', category: 'Eingebaut', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], desc: 'Dateizugriff auf einen frei wählbaren Ordner (zusätzlich zu den eingebauten Tools).' },
  { name: 'fetch', category: 'Eingebaut', command: 'uvx', args: ['mcp-server-fetch'], desc: 'Webseiten abrufen und als Markdown lesen.' },
  { name: 'git', category: 'Eingebaut', command: 'uvx', args: ['mcp-server-git'], desc: 'Git-Repos inspizieren: Log, Diff, Blame, Show.' },
  { name: 'sqlite', category: 'Eingebaut', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', './data.db'], desc: 'SQLite-Datenbanken abfragen und ändern.' },
  { name: 'playwright', category: 'Eingebaut', command: 'npx', args: ['-y', '@playwright/mcp@latest'], desc: 'Browser steuern: Seiten öffnen, klicken, Screenshots (E2E-Tests). Für den webapp-testing-Skill.' },
  { name: 'sequential-thinking', category: 'Eingebaut', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], desc: 'Strukturiertes Schritt-für-Schritt-Denken für komplexe Probleme.' },
  { name: 'github', category: 'Eingebaut', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], desc: 'GitHub: Issues, PRs, Repos.', note: 'GITHUB_PERSONAL_ACCESS_TOKEN in mcp.json eintragen.' },
  { name: 'memory-graph', category: 'Eingebaut', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], desc: 'Wissens-Graph-Gedächtnis (Entitäten & Relationen) über Sessions hinweg.' }
]

const CATEGORY_ORDER = ['Code-Intelligenz', 'Wissen / Docs', 'Wissen / RAG', 'Gedächtnis', 'Web / Suche', 'Web / Browser', 'Datenbanken', 'DevOps', 'Produktivität', 'Eingebaut']

export function MarketPanel(): JSX.Element {
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [busyName, setBusyName] = useState<string | null>(null)
  // per-entry connect error: connectMcp returns { status:'error', error } instead of throwing,
  // so a failed activation must be tracked here rather than rendering a false 'installiert'.
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [gitUrl, setGitUrl] = useState('')
  const [gitMsg, setGitMsg] = useState<string | null>(null)
  const [gitBusy, setGitBusy] = useState(false)
  const [filter, setFilter] = useState('')

  async function refresh(): Promise<void> {
    const defs = (await api.listMcp()) as McpServerDef[]
    setInstalled(new Set(defs.map((d) => d.name)))
  }
  useEffect(() => {
    refresh()
  }, [])

  async function addMcp(entry: CatalogEntry): Promise<void> {
    setBusyName(entry.name)
    try {
      const defs = (await api.listMcp()) as McpServerDef[]
      if (!defs.some((d) => d.name === entry.name)) {
        await api.saveMcp([
          ...defs,
          { name: entry.name, transport: 'stdio', command: entry.command, args: entry.args, enabled: true }
        ])
      }
      const res = await api.connectMcp(entry.name)
      setErrors((prev) => {
        const next = { ...prev }
        if (res.status === 'error') next[entry.name] = res.error ?? 'Verbindung fehlgeschlagen'
        else delete next[entry.name]
        return next
      })
      await refresh()
    } finally {
      setBusyName(null)
    }
  }

  async function installGit(): Promise<void> {
    if (!gitUrl.trim()) return
    setGitBusy(true)
    setGitMsg(null)
    try {
      const res = await api.installFromGit(gitUrl.trim())
      setGitMsg((res.ok ? '✅ ' : '❌ ') + res.message)
      if (res.ok) setGitUrl('')
    } finally {
      setGitBusy(false)
    }
  }

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const match = (e: CatalogEntry): boolean =>
      !q || e.name.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)
    const byCat = new Map<string, CatalogEntry[]>()
    for (const e of MCP_CATALOG) {
      if (!match(e)) continue
      ;(byCat.get(e.category) ?? byCat.set(e.category, []).get(e.category)!).push(e)
    }
    return CATEGORY_ORDER.filter((c) => byCat.has(c)).map((c) => [c, byCat.get(c)!] as const)
  }, [filter])

  return (
    <div className="panel">
      <div className="panel-inner">
        <h1>🛒 Marketplace</h1>
        <p className="sub">
          Geprüfte MCP-Connectors mit einem Klick aktivieren — oder Skills/Plugins direkt aus einem Git-Repo installieren.
        </p>

        <div className="card">
          <h3>Plugin/Skills aus Git installieren</h3>
          <p>Repo mit plugin.json, skills/ oder SKILL.md — landet in ~/.deepcode/plugins/.</p>
          <div className="row" style={{ marginTop: 10 }}>
            <input
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="https://github.com/user/repo"
              onKeyDown={(e) => e.key === 'Enter' && installGit()}
            />
            <button className="btn" style={{ flex: '0 0 auto' }} onClick={installGit} disabled={gitBusy || !gitUrl.trim()}>
              {gitBusy ? 'Installiere…' : 'Installieren'}
            </button>
          </div>
          {gitMsg && <p style={{ marginTop: 10 }}>{gitMsg}</p>}
        </div>

        <div className="row" style={{ margin: '18px 0 10px', alignItems: 'center' }}>
          <h3 style={{ margin: 0, flex: 1 }}>MCP-Connector-Katalog ({MCP_CATALOG.length})</h3>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="🔎 Suchen (Name, Zweck, Kategorie)…"
            style={{ maxWidth: 280 }}
          />
        </div>

        {grouped.map(([cat, entries]) => (
          <div key={cat} style={{ marginBottom: 14 }}>
            <h4 style={{ margin: '8px 0', color: 'var(--text-faint)' }}>{cat}</h4>
            {entries.map((entry) => (
              <div className="card" key={entry.name}>
                <div className="flex-between">
                  <h3>
                    {entry.name}
                    <span className="badge">{entry.command}</span>
                  </h3>
                  {errors[entry.name] ? (
                    <button className="btn sm" onClick={() => addMcp(entry)} disabled={busyName === entry.name}>
                      {busyName === entry.name ? 'Verbinde…' : '↻ Erneut'}
                    </button>
                  ) : installed.has(entry.name) ? (
                    <span className="badge" style={{ color: 'var(--green)' }}>installiert</span>
                  ) : (
                    <button className="btn sm" onClick={() => addMcp(entry)} disabled={busyName === entry.name}>
                      {busyName === entry.name ? 'Verbinde…' : '＋ Aktivieren'}
                    </button>
                  )}
                </div>
                <p>{entry.desc}</p>
                {errors[entry.name] && (
                  <p className="meta" style={{ color: 'var(--red)' }}>
                    Fehler: {errors[entry.name]}
                    {entry.note ? ` — ggf. den nötigen Token setzen (${entry.note})` : ' — ggf. den nötigen Token unter „MCP / Connectors" setzen'}
                  </p>
                )}
                {entry.note && <p className="meta">ℹ {entry.note}</p>}
              </div>
            ))}
          </div>
        ))}
        {grouped.length === 0 && <p style={{ color: 'var(--text-faint)' }}>Kein Connector passt zu „{filter}".</p>}

        <p className="sub" style={{ marginTop: 14 }}>
          Voraussetzungen: npx-Einträge brauchen Node (✓), uvx-Einträge brauchen uv (✓). Server mit „ℹ" brauchen
          einen Token/eine Einstellung — nach dem Aktivieren unter „MCP / Connectors" in der mcp.json eintragen.
        </p>
      </div>
    </div>
  )
}
