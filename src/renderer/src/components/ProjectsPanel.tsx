import { useEffect, useState } from 'react'
import type { ProjectDef, ProjectHealth } from '../../../shared/types'
import { NewFolderDialog } from './NewFolderDialog'

const api = window.deepcode

function HealthView({ h }: { h: ProjectHealth }): JSX.Element {
  return (
    <div className="health">
      <span className="badge">{h.files} Dateien</span>
      <span className="badge">{h.lines.toLocaleString()} Zeilen</span>
      <span className="badge" style={{ color: h.oversized.length ? 'var(--yellow)' : 'var(--green)' }}>
        {h.oversized.length} Datei(en) &gt;250 Zeilen
      </span>
      <span className="badge" style={{ color: h.todos > 20 ? 'var(--yellow)' : undefined }}>
        {h.todos} TODOs
      </span>
      <span className="badge" style={{ color: h.hasTests ? 'var(--green)' : 'var(--red)' }}>
        Tests: {h.hasTests ? 'ja' : 'fehlen'}
      </span>
      {h.gitBranch && (
        <span className="badge">
          ⎇ {h.gitBranch} · {h.gitDirty}Δ{h.lastCommitAge ? ` · ${h.lastCommitAge}` : ''}
        </span>
      )}
      {h.oversized.length > 0 && (
        <div className="meta" style={{ marginTop: 6, width: '100%' }}>
          Größte: {h.oversized.slice(0, 3).map((o) => `${o.path} (${o.lines})`).join(' · ')}
        </div>
      )}
    </div>
  )
}

const COLORS = ['#5b9dff', '#7c5cff', '#3fb950', '#d29922', '#f85149', '#39c5cf']

export function ProjectsPanel({
  onOpenProject
}: {
  onOpenProject: (projectId: string) => void
}): JSX.Element {
  const [items, setItems] = useState<ProjectDef[]>([])
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [editing, setEditing] = useState<ProjectDef | null>(null)
  const [health, setHealth] = useState<Record<string, ProjectHealth | 'loading'>>({})
  const [newFolder, setNewFolder] = useState(false)

  async function checkHealth(p: ProjectDef): Promise<void> {
    setHealth((h) => ({ ...h, [p.id]: 'loading' }))
    const result = (await api.projectHealth(p.cwd)) as ProjectHealth
    setHealth((h) => ({ ...h, [p.id]: result }))
  }

  async function load(): Promise<void> {
    setItems(await api.listProjects())
  }
  useEffect(() => {
    load()
  }, [])

  async function pickDir(): Promise<void> {
    const dir = (await api.pickDirectory()) as string | null
    if (dir) {
      setCwd(dir)
      if (!name) setName(dir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '')
    }
  }

  async function create(): Promise<void> {
    if (!name.trim() || !cwd.trim()) return
    const p: ProjectDef = {
      id: '',
      name: name.trim(),
      cwd: cwd.trim(),
      color: COLORS[items.length % COLORS.length],
      createdAt: 0,
      updatedAt: 0
    }
    await api.saveProject(p)
    setName('')
    setCwd('')
    load()
  }

  async function saveEdit(): Promise<void> {
    if (!editing) return
    await api.saveProject(editing)
    setEditing(null)
    load()
  }

  return (
    <div className="panel">
      {newFolder && (
        <NewFolderDialog
          defaultName={name.trim()}
          onClose={() => setNewFolder(false)}
          onCreated={(path) => {
            setCwd(path)
            if (!name.trim()) setName(path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '')
            setNewFolder(false)
          }}
        />
      )}
      <div className="panel-inner">
        <h1>Projekte</h1>
        <p className="sub">
          Ein Projekt bündelt Chats, Arbeitsverzeichnis, dauerhafte Instruktionen und das aktive Goal (/goal).
          Kosten werden pro Projekt zusammengefasst.
        </p>

        <div className="card">
          <h3>Neues Projekt</h3>
          <div className="row" style={{ marginTop: 12 }}>
            <div className="field">
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mein Projekt" />
            </div>
            <div className="field">
              <label>Ordner</label>
              <div className="row">
                <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="C:\…" />
                <button className="btn ghost" style={{ flex: '0 0 auto' }} onClick={pickDir}>
                  Wählen…
                </button>
                <button
                  className="btn ghost"
                  style={{ flex: '0 0 auto' }}
                  onClick={() => setNewFolder(true)}
                  title="Frischen, leeren Ordner für dieses Projekt anlegen"
                >
                  Neu…
                </button>
              </div>
            </div>
          </div>
          <button className="btn" onClick={create} disabled={!name.trim() || !cwd.trim()}>
            Projekt anlegen
          </button>
        </div>

        {items.length === 0 && <div className="empty">Noch keine Projekte. Lege oben dein erstes an.</div>}
        {items.map((p) =>
          editing?.id === p.id ? (
            <div className="card" key={p.id}>
              <div className="field">
                <label>Name</label>
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </div>
              <div className="field">
                <label>Goal (🎯 wirkt in jedem Chat des Projekts)</label>
                <input
                  value={editing.goal ?? ''}
                  onChange={(e) => setEditing({ ...editing, goal: e.target.value || undefined })}
                  placeholder="z.B. Weltklasse Coding-App, die es mit Claude Code aufnehmen kann"
                />
              </div>
              <div className="field">
                <label>Instruktionen (immer im System-Prompt)</label>
                <textarea
                  value={editing.instructions ?? ''}
                  onChange={(e) => setEditing({ ...editing, instructions: e.target.value || undefined })}
                  placeholder="Konventionen, Stack, Do's & Don'ts für dieses Projekt…"
                />
              </div>
              <div className="field">
                <label>Verify-Befehl (Qualitäts-Gate — läuft nach jeder Änderung, Fehler werden automatisch gefixt)</label>
                <input
                  value={editing.verifyCommand ?? ''}
                  onChange={(e) => setEditing({ ...editing, verifyCommand: e.target.value || undefined })}
                  placeholder="z.B. npm test  ·  npm run typecheck  ·  pytest"
                />
              </div>
              <div className="row">
                <div className="field">
                  <label>Trust-Level (Freigaben in diesem Projekt)</label>
                  <select
                    value={editing.trustLevel ?? 'interactive'}
                    onChange={(e) =>
                      setEditing({ ...editing, trustLevel: e.target.value as ProjectDef['trustLevel'] })
                    }
                  >
                    <option value="interactive">Interaktiv — fragt bei Änderungen</option>
                    <option value="trusted">Vertraut — alles automatisch erlauben</option>
                    <option value="restricted">Eingeschränkt — nur lesen</option>
                  </select>
                </div>
                <div className="field">
                  <label>Auto-Changelog</label>
                  <select
                    value={editing.autoChangelog ? 'on' : 'off'}
                    onChange={(e) => setEditing({ ...editing, autoChangelog: e.target.value === 'on' })}
                  >
                    <option value="off">Aus</option>
                    <option value="on">An — CHANGELOG-DEEPCODE.md pflegen</option>
                  </select>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={saveEdit}>
                  Speichern
                </button>
                <button className="btn ghost" onClick={() => setEditing(null)}>
                  Abbrechen
                </button>
              </div>
            </div>
          ) : (
            <div className="card" key={p.id}>
              <div className="flex-between">
                <h3>
                  <span className="proj-dot" style={{ background: p.color || 'var(--accent)' }} />
                  {p.name}
                </h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn sm" onClick={() => onOpenProject(p.id)}>
                    Öffnen
                  </button>
                  <button className="btn ghost sm" onClick={() => checkHealth(p)}>
                    🩺 Health
                  </button>
                  <button className="btn ghost sm" onClick={() => setEditing(p)}>
                    Bearbeiten
                  </button>
                  <button
                    className="btn danger sm"
                    onClick={async () => {
                      if (!window.confirm(`Projekt "${p.name}" wirklich löschen? Zugehörige Sessions werden ebenfalls entfernt.`)) return
                      await api.deleteProject(p.id)
                      load()
                    }}
                  >
                    Löschen
                  </button>
                </div>
              </div>
              <p className="meta">{p.cwd}</p>
              {p.goal && <p>🎯 {p.goal}</p>}
              {health[p.id] === 'loading' && <p className="meta">Prüfe…</p>}
              {health[p.id] && health[p.id] !== 'loading' && <HealthView h={health[p.id] as ProjectHealth} />}
            </div>
          )
        )}
      </div>
    </div>
  )
}
