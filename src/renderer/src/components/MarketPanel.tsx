import { useEffect, useState } from 'react'
import type { McpServerDef } from '../../../shared/types'

const api = window.deepcode

// Curated, known-good connectors (official MCP reference servers + popular ones).
const MCP_CATALOG: {
  name: string
  desc: string
  command: string
  args: string[]
  note?: string
}[] = [
  {
    name: 'filesystem',
    desc: 'Dateizugriff auf einen frei wählbaren Ordner (zusätzlich zu den eingebauten Tools)',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.']
  },
  {
    name: 'fetch',
    desc: 'Webseiten abrufen und als Markdown lesen',
    command: 'uvx',
    args: ['mcp-server-fetch']
  },
  {
    name: 'git',
    desc: 'Git-Repos inspizieren: Log, Diff, Blame, Show',
    command: 'uvx',
    args: ['mcp-server-git']
  },
  {
    name: 'sqlite',
    desc: 'SQLite-Datenbanken abfragen und ändern',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', './data.db']
  },
  {
    name: 'playwright',
    desc: 'Browser steuern: Seiten öffnen, klicken, Screenshots (E2E-Tests!)',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest']
  },
  {
    name: 'sequential-thinking',
    desc: 'Strukturiertes Schritt-für-Schritt-Denken für komplexe Probleme',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking']
  },
  {
    name: 'github',
    desc: 'GitHub: Issues, PRs, Repos (braucht GITHUB_TOKEN in der Config)',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    note: 'Nach dem Hinzufügen GITHUB_PERSONAL_ACCESS_TOKEN in mcp.json eintragen.'
  },
  {
    name: 'memory-graph',
    desc: 'Wissens-Graph-Gedächtnis (Entitäten & Relationen) über Sessions hinweg',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory']
  }
]

export function MarketPanel(): JSX.Element {
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [busyName, setBusyName] = useState<string | null>(null)
  const [gitUrl, setGitUrl] = useState('')
  const [gitMsg, setGitMsg] = useState<string | null>(null)
  const [gitBusy, setGitBusy] = useState(false)

  async function refresh(): Promise<void> {
    const defs = (await api.listMcp()) as McpServerDef[]
    setInstalled(new Set(defs.map((d) => d.name)))
  }
  useEffect(() => {
    refresh()
  }, [])

  async function addMcp(entry: (typeof MCP_CATALOG)[number]): Promise<void> {
    setBusyName(entry.name)
    try {
      const defs = (await api.listMcp()) as McpServerDef[]
      await api.saveMcp([
        ...defs,
        { name: entry.name, transport: 'stdio', command: entry.command, args: entry.args, enabled: true }
      ])
      await api.connectMcp(entry.name)
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

  return (
    <div className="panel">
      <div className="panel-inner">
        <h1>🛒 Marketplace</h1>
        <p className="sub">
          Geprüfte Connectors mit einem Klick aktivieren — oder Skills/Plugins direkt aus einem
          Git-Repo installieren.
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

        <h3 style={{ margin: '18px 0 10px' }}>MCP-Connector-Katalog</h3>
        {MCP_CATALOG.map((entry) => (
          <div className="card" key={entry.name}>
            <div className="flex-between">
              <h3>
                {entry.name}
                <span className="badge">{entry.command}</span>
              </h3>
              {installed.has(entry.name) ? (
                <span className="badge" style={{ color: 'var(--green)' }}>
                  installiert
                </span>
              ) : (
                <button className="btn sm" onClick={() => addMcp(entry)} disabled={busyName === entry.name}>
                  {busyName === entry.name ? 'Verbinde…' : '＋ Aktivieren'}
                </button>
              )}
            </div>
            <p>{entry.desc}</p>
            {entry.note && <p className="meta">{entry.note}</p>}
          </div>
        ))}
        <p className="sub" style={{ marginTop: 14 }}>
          Voraussetzungen: npx-Einträge brauchen Node (vorhanden ✓), uvx-Einträge brauchen uv (vorhanden ✓).
          Verwaltung & Status unter „MCP / Connectors".
        </p>
      </div>
    </div>
  )
}
