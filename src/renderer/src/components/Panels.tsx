import { useEffect, useState } from 'react'
import type {
  AppSettings,
  AutomationDef,
  HookDef,
  McpServerDef,
  MemoryEntry,
  PluginDef,
  SkillDef,
  SlashCommandDef,
  SubagentDef
} from '../../../shared/types'

const api = window.deepcode

// Encrypted secrets for workflows. Values are write-only — they never come back from main;
// existing names show a placeholder. Use {{secret.NAME}} in tool/shell/http node args.
function SecretsCard(): JSX.Element {
  const [names, setNames] = useState<string[]>([])
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [err, setErr] = useState('')
  const refresh = (): void => {
    api.secretsList().then(setNames).catch(() => setNames([]))
  }
  useEffect(refresh, [])
  async function add(): Promise<void> {
    setErr('')
    try {
      await api.secretSet(name.trim(), value)
      setName('')
      setValue('')
      refresh()
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }
  return (
    <div className="card">
      <h3>🔑 Workflow-Secrets</h3>
      <p>
        Verschlüsselt gespeichert (OS-Schlüsselbund). In Workflow-<b>Tool/Shell/HTTP</b>-Argumenten als{' '}
        <code>{'{{secret.NAME}}'}</code> nutzen. Werte verlassen den Hauptprozess nie und werden aus Ausgaben/Events maskiert.
      </p>
      <div className="row" style={{ marginTop: 12 }}>
        <div className="field">
          <label>Name (A–Z, 0–9, _)</label>
          <input value={name} placeholder="API_TOKEN" onChange={(e) => setName(e.target.value.toUpperCase())} />
        </div>
        <div className="field">
          <label>Wert (wird verschlüsselt)</label>
          <input type="password" value={value} placeholder="•••" onChange={(e) => setValue(e.target.value)} />
        </div>
      </div>
      <button className="btn ghost sm" disabled={!name.trim() || !value} onClick={add}>+ Secret speichern</button>
      {err && <span className="wf-field-err" style={{ display: 'block', marginTop: 6 }}>⚠ {err}</span>}
      {names.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
          {names.map((n) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <code style={{ flex: 1 }}>{n}</code>
              <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>••• gespeichert</span>
              <button className="btn ghost sm" onClick={() => api.secretDelete(n).then(refresh)}>Löschen</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function BackupCard(): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  async function doExport(): Promise<void> {
    setBusy(true)
    setMsg('')
    try {
      const r = await api.exportBackup()
      setMsg(r.ok && r.path ? `✅ Gespeichert: ${r.path}` : 'Abgebrochen.')
    } catch (e) {
      setMsg(`⚠ ${String((e as Error).message ?? e)}`)
    } finally {
      setBusy(false)
    }
  }
  async function doImport(): Promise<void> {
    if (
      !window.confirm(
        'Backup wiederherstellen? Bestehende Konfiguration (Einstellungen, Projekte, Memory, Automationen, Workflows) wird überschrieben.'
      )
    )
      return
    setBusy(true)
    setMsg('')
    try {
      const r = await api.importBackup()
      if (r.ok)
        setMsg(
          `✅ ${r.restored?.length ?? 0} Einträge wiederhergestellt. API-Keys müssen neu eingegeben werden; App-Neustart empfohlen.`
        )
      else setMsg(r.message ? `⚠ ${r.message}` : 'Abgebrochen.')
    } catch (e) {
      setMsg(`⚠ ${String((e as Error).message ?? e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card">
      <h3>💾 Backup / Wiederherstellen</h3>
      <p>
        Exportiert Einstellungen, Projekte, Memory, Automationen, Workflows und MCP-Server als eine portable
        JSON-Datei. <b>API-Keys/Secrets werden NICHT exportiert</b> (gerätegebunden) — nach dem Wiederherstellen
        neu eintragen.
      </p>
      <div className="row" style={{ marginTop: 12, gap: 10 }}>
        <button className="btn ghost sm" disabled={busy} onClick={doExport}>
          ⬇ Backup exportieren
        </button>
        <button className="btn ghost sm" disabled={busy} onClick={doImport}>
          ⬆ Wiederherstellen…
        </button>
      </div>
      {msg && (
        <span style={{ display: 'block', marginTop: 8, color: 'var(--text-faint)', fontSize: 12 }}>{msg}</span>
      )}
    </div>
  )
}

function Switch({ on, onClick }: { on: boolean; onClick: () => void }): JSX.Element {
  // a real role="switch" button → focusable + keyboard-operable (Space/Enter) for free, unlike
  // a bare <span> which keyboard / screen-reader users could never toggle.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={'switch' + (on ? ' on' : '')}
      onClick={onClick}
    />
  )
}

// Manage the persistent, cwd-scoped "Immer erlauben" shell-command allowlist.
function AllowlistCard(): JSX.Element {
  const [cmds, setCmds] = useState<{ command: string; cwd: string }[]>([])
  useEffect(() => {
    void api.listApprovedCommands().then(setCmds)
  }, [])
  async function remove(command: string, cwd: string): Promise<void> {
    setCmds(await api.removeApprovedCommand(command, cwd))
  }
  return (
    <div className="card">
      <h3>✅ Auto-erlaubte Befehle</h3>
      <p>
        Befehle, die du mit <b>„Immer erlauben"</b> bestätigt hast, laufen künftig ohne Nachfrage — aber nur im
        jeweiligen Projektordner. Gefährliche Befehle werden nie automatisch erlaubt. Hier kannst du Einträge entfernen.
      </p>
      {cmds.length === 0 ? (
        <p style={{ color: 'var(--text-faint)' }}>Noch keine — der Eintrag entsteht über den Approval-Dialog.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
          {cmds.map((c) => (
            <div key={c.command + ' ' + c.cwd} className="row" style={{ alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <code style={{ fontFamily: 'var(--mono)', fontSize: 12, wordBreak: 'break-all' }}>{c.command}</code>
                <div style={{ fontSize: 11, color: 'var(--text-faint)', wordBreak: 'break-all' }}>
                  {c.cwd || '(beliebiger Ordner)'}
                </div>
              </div>
              <button
                className="btn ghost sm"
                style={{ flex: '0 0 auto' }}
                onClick={() => remove(c.command, c.cwd)}
              >
                Entfernen
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PanelShell({
  title,
  sub,
  children
}: {
  title: string
  sub: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="panel">
      <div className="panel-inner">
        <h1>{title}</h1>
        <p className="sub">{sub}</p>
        {children}
      </div>
    </div>
  )
}

// ---- Settings ----
export function SettingsPanel({
  settings,
  onSettings
}: {
  settings: AppSettings
  onSettings: (s: AppSettings) => void
}): JSX.Element {
  const [s, setS] = useState<AppSettings>(settings)
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)
  const p = s.provider

  // re-sync the local copy when settings change OUTSIDE this panel (e.g. the sidebar theme
  // toggle) — but only when there are no unsaved edits, so we don't clobber the user's input.
  // Without this, save() would write the stale snapshot and silently revert the external change.
  useEffect(() => {
    if (!dirty) setS(settings)
  }, [settings, dirty])

  function update(patch: Partial<AppSettings>): void {
    setS((cur) => ({ ...cur, ...patch }))
    setSaved(false)
    setDirty(true)
  }
  function updateProvider(patch: Partial<AppSettings['provider']>): void {
    setS((cur) => ({ ...cur, provider: { ...cur.provider, ...patch } }))
    setSaved(false)
    setDirty(true)
  }

  async function save(): Promise<void> {
    const next = await api.saveSettings(s)
    onSettings(next)
    setSaved(true)
    setDirty(false)
  }

  async function pick(): Promise<void> {
    const dir = await api.pickDirectory()
    if (dir) update({ defaultCwd: dir })
  }

  return (
    <PanelShell title="Settings" sub="DeepSeek provider, permissions, and default behavior.">
      <div className="card">
        <h3>DeepSeek provider</h3>
        <p>Any OpenAI-compatible endpoint works. Set your model id (e.g. deepseek-chat, deepseek-reasoner, or your "v4 PRO" id).</p>
        <div className="field" style={{ marginTop: 14 }}>
          <label>API key</label>
          <input
            type="password"
            value={p.apiKey}
            placeholder="sk-…"
            onChange={(e) => updateProvider({ apiKey: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Base URL</label>
          <input value={p.baseUrl} onChange={(e) => updateProvider({ baseUrl: e.target.value })} />
        </div>
        <div className="field">
          <label>Lokale Modelle — Endpoint (Ollama / LM Studio, OpenAI-kompatibel)</label>
          <input
            value={p.localBaseUrl ?? 'http://localhost:11434/v1'}
            onChange={(e) => updateProvider({ localBaseUrl: e.target.value })}
            placeholder="http://localhost:11434/v1"
          />
        </div>
        <div className="field">
          <label>🔓 Uncensored-Modell (für den Topbar-Schalter — lokal, ungefiltert)</label>
          <input
            value={p.uncensoredModel ?? 'local:dolphin3'}
            onChange={(e) => updateProvider({ uncensoredModel: e.target.value })}
            placeholder="local:dolphin3"
          />
        </div>
        <div className="field">
          <label>👁 Vision-Modell LOKAL (Ollama — genutzt im LOKAL-Modus, wenn du ein Bild anhängst)</label>
          <input
            value={p.visionModel ?? 'local:qwen2.5vl:7b'}
            onChange={(e) => updateProvider({ visionModel: e.target.value })}
            placeholder="local:qwen2.5vl:7b"
          />
        </div>
        <div className="field">
          <label>🔎 Embedding-Modell (lokal, für semantic_search — z.B. nomic-embed-text)</label>
          <input
            value={p.embeddingModel ?? 'nomic-embed-text'}
            onChange={(e) => updateProvider({ embeddingModel: e.target.value })}
            placeholder="nomic-embed-text"
          />
        </div>
        <div className="row">
          <div className="field">
            <label>Model</label>
            <input value={p.model} onChange={(e) => updateProvider({ model: e.target.value })} />
          </div>
          <div className="field">
            <label>Reasoner model (for subagents)</label>
            <input
              value={p.reasonerModel}
              onChange={(e) => updateProvider({ reasonerModel: e.target.value })}
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>Temperature</label>
            <input
              type="number"
              step="0.1"
              value={p.temperature}
              onChange={(e) => updateProvider({ temperature: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>Max tokens</label>
            <input
              type="number"
              value={p.maxTokens}
              onChange={(e) => updateProvider({ maxTokens: Number(e.target.value) })}
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>Price / 1M input tokens ($)</label>
            <input
              type="number"
              step="0.01"
              value={p.pricePerMillionInput}
              onChange={(e) => updateProvider({ pricePerMillionInput: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>Price / 1M output tokens ($)</label>
            <input
              type="number"
              step="0.01"
              value={p.pricePerMillionOutput}
              onChange={(e) => updateProvider({ pricePerMillionOutput: Number(e.target.value) })}
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>Reasoner-Preis / 1M Input ($)</label>
            <input
              type="number"
              step="0.01"
              value={p.reasonerPricePerMillionInput ?? 0.55}
              onChange={(e) => updateProvider({ reasonerPricePerMillionInput: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>Reasoner-Preis / 1M Output ($)</label>
            <input
              type="number"
              step="0.01"
              value={p.reasonerPricePerMillionOutput ?? 2.19}
              onChange={(e) => updateProvider({ reasonerPricePerMillionOutput: Number(e.target.value) })}
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>Cache-Treffer-Preis / 1M Input ($) — DeepSeek bucht gecachte Tokens günstiger</label>
            <input
              type="number"
              step="0.01"
              value={p.cachedPricePerMillionInput ?? 0.07}
              onChange={(e) => updateProvider({ cachedPricePerMillionInput: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>Reasoner-Cache-Treffer / 1M Input ($)</label>
            <input
              type="number"
              step="0.01"
              value={p.reasonerCachedPricePerMillionInput ?? 0.14}
              onChange={(e) => updateProvider({ reasonerCachedPricePerMillionInput: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h3>👁 Bild-Analyse (Vision)</h3>
        <p>
          DeepSeek kann keine Bilder sehen. Hängst du eines an, beschreibt es ein Vision-Modell zuerst —
          <b> ONLINE</b> via Gemini (Google AI Studio) oder <b>LOKAL</b> via Ollama — und DeepSeek arbeitet
          dann mit dieser Beschreibung weiter. Den Modus schaltest du auch direkt oben rechts im Chat um.
        </p>
        <label className="toggle" style={{ marginTop: 12 }}>
          <Switch on={s.visionMode === 'online'} onClick={() => update({ visionMode: s.visionMode === 'online' ? 'local' : 'online' })} />
          Bild-Analyse <b>ONLINE</b> (Gemini) — aus = <b>LOKAL</b> (Ollama)
        </label>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Google-AI-Studio-Key (Gemini) — verschlüsselt gespeichert</label>
          <input
            type="password"
            value={p.googleApiKey ?? ''}
            placeholder="AIza…"
            onChange={(e) => updateProvider({ googleApiKey: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Online-Vision-Modell (Gemini)</label>
          <input
            value={p.onlineVisionModel ?? 'gemini-2.5-flash-lite'}
            onChange={(e) => updateProvider({ onlineVisionModel: e.target.value })}
            placeholder="gemini-2.5-flash-lite"
          />
        </div>
        <div className="field">
          <label>Google Base URL (OpenAI-kompatibel)</label>
          <input
            value={p.googleBaseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai'}
            onChange={(e) => updateProvider({ googleBaseUrl: e.target.value })}
            placeholder="https://generativelanguage.googleapis.com/v1beta/openai"
          />
        </div>
      </div>

      <div className="card">
        <h3>☁️ DeepInfra (zusätzliche Modelle)</h3>
        <p>
          OpenAI-kompatibler Anbieter. Modelle mit Präfix <code>deepinfra:</code> werden hierhin geroutet und erscheinen
          im Modell-Auswahlmenü (oben rechts im Chat).
        </p>
        <div className="field" style={{ marginTop: 12 }}>
          <label>DeepInfra-API-Key — verschlüsselt gespeichert</label>
          <input
            type="password"
            value={p.deepinfraApiKey ?? ''}
            placeholder="…"
            onChange={(e) => updateProvider({ deepinfraApiKey: e.target.value })}
          />
        </div>
        <div className="field">
          <label>DeepInfra Base URL (OpenAI-kompatibel)</label>
          <input
            value={p.deepinfraBaseUrl ?? 'https://api.deepinfra.com/v1/openai'}
            onChange={(e) => updateProvider({ deepinfraBaseUrl: e.target.value })}
            placeholder="https://api.deepinfra.com/v1/openai"
          />
        </div>
        <div className="field">
          <label>Modelle im Auswahlmenü (eine ID pro Zeile, Präfix <code>deepinfra:</code>)</label>
          <textarea
            style={{ minHeight: 84, fontFamily: 'var(--mono)', fontSize: 12 }}
            value={(p.extraModels ?? []).join('\n')}
            onChange={(e) =>
              updateProvider({ extraModels: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean) })
            }
            placeholder={'deepinfra:deepseek-ai/DeepSeek-V4-Flash\ndeepinfra:openai/gpt-oss-120b'}
          />
        </div>
        <div className="row">
          <div className="field">
            <label>DeepInfra Preis Input ($/1M Tokens)</label>
            <input
              type="number"
              step="0.01"
              value={p.deepinfraPricePerMillionInput ?? 0.3}
              onChange={(e) => updateProvider({ deepinfraPricePerMillionInput: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>DeepInfra Preis Output ($/1M Tokens)</label>
            <input
              type="number"
              step="0.01"
              value={p.deepinfraPricePerMillionOutput ?? 0.5}
              onChange={(e) => updateProvider({ deepinfraPricePerMillionOutput: Number(e.target.value) })}
            />
          </div>
        </div>
        <p className="sub" style={{ marginTop: 4 }}>
          Pauschalpreis pro Vendor (kein Reasoner/Cache-Split). DeepSeek-Preise gelten NICHT für <code>deepinfra:</code>-Modelle.
        </p>
      </div>

      <div className="card">
        <h3>🤖 OpenAI (zusätzliche Modelle)</h3>
        <p>
          OpenAI-kompatibel. Modelle mit Präfix <code>openai:</code> (z.B. <code>openai:gpt-4o</code>) werden hierhin geroutet.
          Füge sie oben bei „Modelle im Auswahlmenü" hinzu — auch pro Workflow-Agent-Step via Modell-Feld nutzbar.
        </p>
        <div className="field" style={{ marginTop: 12 }}>
          <label>OpenAI-API-Key — verschlüsselt gespeichert</label>
          <input
            type="password"
            value={p.openaiApiKey ?? ''}
            placeholder="sk-…"
            onChange={(e) => updateProvider({ openaiApiKey: e.target.value })}
          />
        </div>
        <div className="field">
          <label>OpenAI Base URL (OpenAI-kompatibel)</label>
          <input
            value={p.openaiBaseUrl ?? 'https://api.openai.com/v1'}
            onChange={(e) => updateProvider({ openaiBaseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </div>
        <div className="row">
          <div className="field">
            <label>OpenAI Preis Input ($/1M Tokens)</label>
            <input
              type="number"
              step="0.01"
              value={p.openaiPricePerMillionInput ?? 0.5}
              onChange={(e) => updateProvider({ openaiPricePerMillionInput: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>OpenAI Preis Output ($/1M Tokens)</label>
            <input
              type="number"
              step="0.01"
              value={p.openaiPricePerMillionOutput ?? 1.5}
              onChange={(e) => updateProvider({ openaiPricePerMillionOutput: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h3>🧩 Together AI (zusätzliche Modelle)</h3>
        <p>
          OpenAI-kompatibel. Modelle mit Präfix <code>together:</code> (z.B.{' '}
          <code>together:meta-llama/Llama-3.3-70B-Instruct-Turbo</code>) werden hierhin geroutet. Hinweis:
          Llama-4-Modelle (Scout/Maverick) brauchen ein <b>dediziertes Together-Endpoint</b>; viele andere
          (z.B. Llama-3.3-70B-Turbo) laufen serverless sofort.
        </p>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Together-API-Key — verschlüsselt gespeichert</label>
          <input
            type="password"
            value={p.togetherApiKey ?? ''}
            placeholder="tgp_…"
            onChange={(e) => updateProvider({ togetherApiKey: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Together Base URL (OpenAI-kompatibel)</label>
          <input
            value={p.togetherBaseUrl ?? 'https://api.together.xyz/v1'}
            onChange={(e) => updateProvider({ togetherBaseUrl: e.target.value })}
            placeholder="https://api.together.xyz/v1"
          />
        </div>
        <div className="row">
          <div className="field">
            <label>Together Preis Input ($/1M Tokens)</label>
            <input
              type="number"
              step="0.01"
              value={p.togetherPricePerMillionInput ?? 0.18}
              onChange={(e) => updateProvider({ togetherPricePerMillionInput: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>Together Preis Output ($/1M Tokens)</label>
            <input
              type="number"
              step="0.01"
              value={p.togetherPricePerMillionOutput ?? 0.59}
              onChange={(e) => updateProvider({ togetherPricePerMillionOutput: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h3>📱 Xiaomi MiMo (Token-Plan — kostenlose Credits)</h3>
        <p>
          OpenAI-kompatibel. Modelle mit Präfix <code>mimo:</code> (z.B. <code>mimo:mimo-v2.5-pro</code>)
          werden hierhin geroutet. Der Token-Plan ist <b>nur für interaktive Coding-/Agent-Tools</b>
          gedacht (laut MiMo kein automatisierter Backend-Einsatz) — DeepCode zählt dazu.
        </p>
        <div className="field" style={{ marginTop: 12 }}>
          <label>MiMo-API-Key — verschlüsselt gespeichert</label>
          <input
            type="password"
            value={p.mimoApiKey ?? ''}
            placeholder="tp-…"
            onChange={(e) => updateProvider({ mimoApiKey: e.target.value })}
          />
        </div>
        <div className="field">
          <label>MiMo Base URL (OpenAI-kompatibel)</label>
          <input
            value={p.mimoBaseUrl ?? 'https://token-plan-ams.xiaomimimo.com/v1'}
            onChange={(e) => updateProvider({ mimoBaseUrl: e.target.value })}
            placeholder="https://token-plan-ams.xiaomimimo.com/v1"
          />
        </div>
        <div className="row">
          <div className="field">
            <label>MiMo Preis Input ($/1M Tokens)</label>
            <input
              type="number"
              step="0.01"
              value={p.mimoPricePerMillionInput ?? 0}
              onChange={(e) => updateProvider({ mimoPricePerMillionInput: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>MiMo Preis Output ($/1M Tokens)</label>
            <input
              type="number"
              step="0.01"
              value={p.mimoPricePerMillionOutput ?? 0}
              onChange={(e) => updateProvider({ mimoPricePerMillionOutput: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h3>🦘 Kilo Code (Gateway — Gratis-Credits)</h3>
        <p>
          OpenAI-kompatibler Gateway zu vielen Modellen (Claude, GPT, Gemini …). Modelle mit Präfix{' '}
          <code>kilo:</code> (z.B. <code>kilo:kilo/auto</code> für Smart-Routing oder{' '}
          <code>kilo:anthropic/claude-sonnet-4</code>) werden hierhin geroutet. Key holen unter
          {' '}<b>app.kilo.ai → API Keys</b>; die genauen Modell-IDs stehen in deinem Kilo-Dashboard.
        </p>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Kilo-Code-API-Key — verschlüsselt gespeichert</label>
          <input
            type="password"
            value={p.kiloApiKey ?? ''}
            placeholder="kilo-…"
            onChange={(e) => updateProvider({ kiloApiKey: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Kilo Base URL (OpenAI-kompatibel)</label>
          <input
            value={p.kiloBaseUrl ?? 'https://api.kilo.ai/api/gateway'}
            onChange={(e) => updateProvider({ kiloBaseUrl: e.target.value })}
            placeholder="https://api.kilo.ai/api/gateway"
          />
        </div>
        <div className="row">
          <div className="field">
            <label>Kilo Preis Input ($/1M Tokens)</label>
            <input
              type="number"
              step="0.01"
              value={p.kiloPricePerMillionInput ?? 0}
              onChange={(e) => updateProvider({ kiloPricePerMillionInput: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>Kilo Preis Output ($/1M Tokens)</label>
            <input
              type="number"
              step="0.01"
              value={p.kiloPricePerMillionOutput ?? 0}
              onChange={(e) => updateProvider({ kiloPricePerMillionOutput: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h3>🌐 OpenRouter (Aggregator — viele Anbieter, ein Key)</h3>
        <p>
          OpenAI-kompatibler Zugang zu hunderten Modellen. Modelle mit Präfix <code>openrouter:</code>{' '}
          (z.B. <code>openrouter:xiaomi/mimo-v2.5-pro</code> — dasselbe MiMo, aber deutlich günstiger als
          über DeepInfra) werden hierhin geroutet. Die Kosten kommen direkt von OpenRouter
          (<code>usage.cost</code>), stimmen also exakt mit deiner OpenRouter-Abrechnung überein. Key holen
          unter <b>openrouter.ai/keys</b>.
        </p>
        <div className="field" style={{ marginTop: 12 }}>
          <label>OpenRouter-API-Key — verschlüsselt gespeichert</label>
          <input
            type="password"
            value={p.openrouterApiKey ?? ''}
            placeholder="sk-or-…"
            onChange={(e) => updateProvider({ openrouterApiKey: e.target.value })}
          />
        </div>
        <div className="field">
          <label>OpenRouter Base URL (OpenAI-kompatibel)</label>
          <input
            value={p.openrouterBaseUrl ?? 'https://openrouter.ai/api/v1'}
            onChange={(e) => updateProvider({ openrouterBaseUrl: e.target.value })}
            placeholder="https://openrouter.ai/api/v1"
          />
        </div>
        <div className="row">
          <div className="field">
            <label>OpenRouter Preis Input ($/1M, nur Fallback)</label>
            <input
              type="number"
              step="0.01"
              value={p.openrouterPricePerMillionInput ?? 0}
              onChange={(e) => updateProvider({ openrouterPricePerMillionInput: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>OpenRouter Preis Output ($/1M, nur Fallback)</label>
            <input
              type="number"
              step="0.01"
              value={p.openrouterPricePerMillionOutput ?? 0}
              onChange={(e) => updateProvider({ openrouterPricePerMillionOutput: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <SecretsCard />

      <BackupCard />

      <div className="card">
        <h3>Permissions (auto-approve)</h3>
        <p>When off, DeepCode asks before each action of that type.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <label className="toggle">
            <Switch on={s.autoApprove.read} onClick={() => update({ autoApprove: { ...s.autoApprove, read: !s.autoApprove.read } })} />
            Auto-approve <b>reads</b> (read_file, grep, glob, list_dir)
          </label>
          <label className="toggle">
            <Switch on={s.autoApprove.write} onClick={() => update({ autoApprove: { ...s.autoApprove, write: !s.autoApprove.write } })} />
            Auto-approve <b>file changes</b> (write_file, edit_file)
          </label>
          <label className="toggle">
            <Switch on={s.autoApprove.bash} onClick={() => update({ autoApprove: { ...s.autoApprove, bash: !s.autoApprove.bash } })} />
            Auto-approve <b>shell commands</b> (run_command)
          </label>
        </div>
      </div>

      <div className="card">
        <h3>Safety</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <label className="toggle">
            <Switch on={s.confineToCwd} onClick={() => update({ confineToCwd: !s.confineToCwd })} />
            Confine file tools to the working directory (block <code style={{ fontFamily: 'var(--mono)' }}>../</code> escapes)
          </label>
          <label className="toggle">
            <Switch on={s.watcherEnabled} onClick={() => update({ watcherEnabled: !s.watcherEnabled })} />
            👀 Live-Wächter — melden, wenn Projektdateien extern geändert werden (Editor, Git)
          </label>
          <label className="toggle">
            <Switch on={s.selfReview} onClick={() => update({ selfReview: !s.selfReview })} />
            🔍 Selbst-Review — nach jeder Änderung prüft der Agent seinen eigenen Code (≈ doppelte Tokens, deutlich weniger Bugs)
          </label>
          <label className="toggle">
            <Switch on={s.proveChanges} onClick={() => update({ proveChanges: !s.proveChanges })} />
            🧪 Beweisbare Änderungen — hat das Projekt keinen Verify-Befehl, schreibt der Agent einen fokussierten Test und beweist ihn rot→grün (schlägt gegen den alten Code fehl, besteht gegen den neuen). Opt-in; kostet eine zusätzliche Runde + ein paar Testläufe.
          </label>
          <label className="toggle">
            <Switch on={s.autoRouteModels} onClick={() => update({ autoRouteModels: !s.autoRouteModels })} />
            💸 Auto-Modell-Routing — wenn du den Reasoner als Session-Modell wählst, läuft die Agenten-Schleife auf dem günstigen Chat-Modell (der Reasoner kann keine Tools aufrufen): spart Kosten und macht Tool-Nutzung überhaupt erst möglich
          </label>
          <label className="toggle">
            <Switch on={s.autoMemory} onClick={() => update({ autoMemory: !s.autoMemory })} />
            🧠 Auto-Memory — bei jeder Verdichtung (Compaction) werden bleibende Fakten automatisch ins Memory aufgenommen (sonst nur manuell mit /remember). Ein zusätzlicher günstiger LLM-Aufruf pro Compaction.
          </label>
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label>Max-Kosten pro Turn in $ (0 = aus) — der Agent pausiert bei Überschreitung statt weiterzulaufen</label>
          <input
            type="number"
            step="0.05"
            value={s.maxCostPerTurn ?? 0}
            onChange={(e) => update({ maxCostPerTurn: Number(e.target.value) })}
            placeholder="z.B. 0.50"
          />
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label>Tages-Budget in $ (0 = aus) — unbeaufsichtigte Läufe (Cron-Workflows, Automations, Nachtschicht) werden übersprungen, sobald heute so viel ausgegeben wurde</label>
          <input
            type="number"
            step="0.50"
            value={s.maxCostPerDay ?? 0}
            onChange={(e) => update({ maxCostPerDay: Number(e.target.value) })}
            placeholder="z.B. 5.00"
          />
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label>Auto-compact threshold (tokens, 0 = off)</label>
          <input
            type="number"
            value={s.compactThreshold}
            onChange={(e) => update({ compactThreshold: Number(e.target.value) })}
            placeholder="e.g. 80000"
          />
        </div>
        <div className="field">
          <label>Monatsbudget in $ (0 = aus) — Warnung im Kosten-Panel bei Überschreitung</label>
          <input
            type="number"
            step="0.5"
            value={s.monthlyBudget ?? 0}
            onChange={(e) => update({ monthlyBudget: Number(e.target.value) })}
            placeholder="z.B. 5"
          />
        </div>
      </div>

      <div className="card">
        <h3>Defaults</h3>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Default working directory</label>
          <div className="row">
            <input value={s.defaultCwd} onChange={(e) => update({ defaultCwd: e.target.value })} />
            <button className="btn ghost" style={{ flex: '0 0 auto' }} onClick={pick}>
              Browse…
            </button>
          </div>
        </div>
        <div className="field">
          <label>Custom instructions (added to every system prompt)</label>
          <textarea
            value={s.customInstructions}
            onChange={(e) => update({ customInstructions: e.target.value })}
            placeholder="e.g. Always use TypeScript. Prefer functional components. Run npm test after changes."
          />
        </div>
      </div>

      <div className="card">
        <h3>🤝 Claude Code als Helfer-Tool</h3>
        <p>
          Lässt den DeepSeek-Agenten bei Bedarf die <b>Claude Code CLI</b> als Werkzeug aufrufen (für
          Zweitmeinung, Tiefen-Analyse oder harte Teilaufgaben). DeepSeek bleibt der Brain. Kosten laufen
          über dein <b>Anthropic-Konto</b>, nicht über DeepSeek. Setzt installiertes <code>claude</code> voraus.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <label className="toggle">
            <Switch
              on={s.claudeCode.enabled}
              onClick={() => update({ claudeCode: { ...s.claudeCode, enabled: !s.claudeCode.enabled } })}
            />
            <code>claude_code</code>-Tool aktivieren
          </label>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Pfad zur claude-Binary</label>
          <input
            value={s.claudeCode.path}
            onChange={(e) => update({ claudeCode: { ...s.claudeCode, path: e.target.value } })}
            placeholder="claude"
          />
        </div>
        <div className="row">
          <div className="field">
            <label>Berechtigung (Obergrenze)</label>
            <select
              className="model-select"
              value={s.claudeCode.permissionMode}
              onChange={(e) =>
                update({ claudeCode: { ...s.claudeCode, permissionMode: e.target.value as 'plan' | 'acceptEdits' } })
              }
            >
              <option value="plan">plan — nur lesen/analysieren (sicher)</option>
              <option value="acceptEdits">acceptEdits — darf Dateien ändern</option>
            </select>
          </div>
          <div className="field">
            <label>Modell (leer = Claude-Standard)</label>
            <input
              value={s.claudeCode.model}
              onChange={(e) => update({ claudeCode: { ...s.claudeCode, model: e.target.value } })}
              placeholder="sonnet / opus / leer"
            />
          </div>
        </div>
        <div className="field">
          <label>Budget-Limit pro Aufruf in $ (0 = aus)</label>
          <input
            type="number"
            step="0.5"
            value={s.claudeCode.maxBudgetUsd}
            onChange={(e) => update({ claudeCode: { ...s.claudeCode, maxBudgetUsd: Number(e.target.value) } })}
            placeholder="z.B. 2"
          />
        </div>
      </div>

      <AllowlistCard />

      <button className="btn" onClick={save}>
        {saved ? 'Saved ✓' : 'Save settings'}
      </button>

      <AboutCard />
    </PanelShell>
  )
}

function AboutCard(): JSX.Element {
  const [info, setInfo] = useState<{ version: string; electron: string } | null>(null)
  const [checkMsg, setCheckMsg] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    api.getAppInfo().then(setInfo)
  }, [])
  async function check(): Promise<void> {
    setChecking(true)
    setCheckMsg(null)
    try {
      const r = await api.checkUpdates()
      setCheckMsg(
        (r.status === 'available' ? '⬇ ' : r.status === 'uptodate' ? '✅ ' : r.status === 'dev' ? 'ℹ ' : '⚠ ') +
          (r.message ?? r.status)
      )
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h3>🐋 Über DeepCode</h3>
      <p className="meta">
        Version {info?.version ?? '…'} · Electron {info?.electron ?? '…'} · DeepSeek-powered
      </p>
      <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn ghost sm" onClick={check} disabled={checking}>
          {checking ? 'Prüfe…' : 'Auf Updates prüfen'}
        </button>
      </div>
      {checkMsg && <p style={{ marginTop: 10 }}>{checkMsg}</p>}
    </div>
  )
}

// ---- generic list panel for file-based systems ----
function FileSystemHint({ dir }: { dir: string }): JSX.Element {
  return (
    <p className="sub" style={{ marginTop: 16 }}>
      Add your own under <code style={{ fontFamily: 'var(--mono)' }}>~/.deepcode/{dir}</code> (global) or{' '}
      <code style={{ fontFamily: 'var(--mono)' }}>&lt;project&gt;/.deepcode/{dir}</code> (per project).
      Use “Open config folder” above.
    </p>
  )
}

export function SkillsPanel({ cwd }: { cwd?: string }): JSX.Element {
  const [items, setItems] = useState<SkillDef[]>([])
  useEffect(() => {
    api.listSkills(cwd).then(setItems)
  }, [cwd])
  return (
    <PanelShell
      title="Skills"
      sub="Step-by-step instructions for specific tasks. DeepCode loads a skill (use_skill) when it matches your request."
    >
      {items.length === 0 && <div className="empty">No skills installed yet.</div>}
      {items.map((sk) => (
        <div className="card" key={sk.path}>
          <div className="flex-between">
            <h3>
              {sk.name}
              <span className={'badge ' + sk.source}>{sk.source}</span>
            </h3>
          </div>
          <p>{sk.description}</p>
        </div>
      ))}
      <FileSystemHint dir="skills" />
    </PanelShell>
  )
}

export function CommandsPanel({ cwd }: { cwd?: string }): JSX.Element {
  const [items, setItems] = useState<SlashCommandDef[]>([])
  useEffect(() => {
    api.listCommands(cwd).then(setItems)
  }, [cwd])
  return (
    <PanelShell title="Slash Commands" sub="Reusable prompt templates triggered by typing /name in the chat.">
      {items.length === 0 && <div className="empty">No custom commands yet. Built-ins: /help, /init.</div>}
      {items.map((c) => (
        <div className="card" key={c.path}>
          <h3>
            /{c.name}
            <span className={'badge ' + c.source}>{c.source}</span>
          </h3>
          <p>{c.description}</p>
        </div>
      ))}
      <FileSystemHint dir="commands" />
    </PanelShell>
  )
}

export function SubagentsPanel({ cwd }: { cwd?: string }): JSX.Element {
  const [items, setItems] = useState<SubagentDef[]>([])
  useEffect(() => {
    api.listSubagents(cwd).then(setItems)
  }, [cwd])
  return (
    <PanelShell
      title="Subagents"
      sub="Specialized assistants DeepCode can delegate to (the task tool). Each has its own prompt and tool set."
    >
      {items.length === 0 && <div className="empty">No subagents defined yet.</div>}
      {items.map((a) => (
        <div className="card" key={a.name + a.source}>
          <h3>
            {a.name}
            <span className={'badge ' + a.source}>{a.source}</span>
          </h3>
          <p>{a.description}</p>
          <div className="meta" style={{ marginTop: 6 }}>
            tools: {a.tools.join(', ')}
            {a.model ? ` · model: ${a.model}` : ''}
          </div>
        </div>
      ))}
      <FileSystemHint dir="agents" />
    </PanelShell>
  )
}

export function HooksPanel({ cwd }: { cwd?: string }): JSX.Element {
  const [items, setItems] = useState<HookDef[]>([])
  useEffect(() => {
    api.listHooks(cwd).then(setItems)
  }, [cwd])
  return (
    <PanelShell
      title="Hooks"
      sub="Shell commands that run automatically on events: UserPromptSubmit, PreToolUse, PostToolUse, Stop."
    >
      {items.length === 0 && <div className="empty">No hooks configured.</div>}
      {items.map((h, i) => (
        <div className="card" key={i}>
          <h3>
            {h.event}
            {h.matcher ? <span className="badge">{h.matcher}</span> : null}
            <span className={'badge ' + h.source}>{h.source}</span>
          </h3>
          <p className="meta">{h.command}</p>
        </div>
      ))}
      <p className="sub" style={{ marginTop: 16 }}>
        Configure in <code style={{ fontFamily: 'var(--mono)' }}>~/.deepcode/hooks.json</code>.
      </p>
    </PanelShell>
  )
}

// ---- Memory ----
// Friendly German labels for the memory types (the stored value stays user/feedback/reference).
const MEM_TYPE_LABEL: Record<string, string> = {
  user: 'Rollen/Vorlieben',
  feedback: 'Anweisung',
  reference: 'Fakten',
  project: 'Projekt'
}

export function MemoryPanel(): JSX.Element {
  const [items, setItems] = useState<MemoryEntry[]>([])
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [body, setBody] = useState('')
  const [type, setType] = useState<MemoryEntry['type']>('user')

  async function load(): Promise<void> {
    setItems(await api.listMemory())
  }
  useEffect(() => {
    load()
  }, [])

  async function add(): Promise<void> {
    if (!name.trim() || !body.trim()) return
    // saveMemory slugifies the name; mirror that here so a colliding slug is visible and never
    // silently overwrites an existing entry.
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const collision = items.some((m) => m.name === slug)
    if (collision && !window.confirm(`Memory „${slug}" existiert bereits — überschreiben?`)) return
    await api.saveMemory({ name, description: desc, body, type })
    window.alert(`Gespeichert als „${slug}".`)
    setName('')
    setDesc('')
    setBody('')
    load()
  }

  return (
    <PanelShell title="Memory" sub="Durable knowledge, rules and preferences kept across sessions and injected into context.">
      <div className="card">
        <h3>Add a memory</h3>
        <div className="row" style={{ marginTop: 12 }}>
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. test-command" />
          </div>
          <div className="field">
            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value as MemoryEntry['type'])}>
              <option value="user">{MEM_TYPE_LABEL.user}</option>
              <option value="feedback">{MEM_TYPE_LABEL.feedback}</option>
              <option value="reference">{MEM_TYPE_LABEL.reference}</option>
            </select>
            {/* 'project' intentionally omitted: this global panel has no project context, so a
                project-scoped memory can't get a projectId. Use /remember inside a project session. */}
          </div>
        </div>
        <div className="field">
          <label>Description</label>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="one-line summary" />
        </div>
        <div className="field">
          <label>Content</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="The fact to remember…" />
        </div>
        <button className="btn" onClick={add}>
          Save memory
        </button>
      </div>

      {items.length === 0 && <div className="empty">No memories yet.</div>}
      {items.map((m) => (
        <div className="card" key={m.path}>
          <div className="flex-between">
            <h3>
              {m.name}
              <span className="badge">{MEM_TYPE_LABEL[m.type] ?? m.type}</span>
            </h3>
            <button
              className="btn danger sm"
              onClick={async () => {
                await api.deleteMemory(m.name)
                load()
              }}
            >
              Delete
            </button>
          </div>
          <p>{m.description}</p>
          <p className="meta" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{m.body}</p>
        </div>
      ))}
    </PanelShell>
  )
}

// ---- MCP ----
export function McpPanel(): JSX.Element {
  const [items, setItems] = useState<McpServerDef[]>([])
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [argsStr, setArgsStr] = useState('')

  async function load(): Promise<void> {
    setItems(await api.listMcp())
  }
  useEffect(() => {
    load()
  }, [])

  async function add(): Promise<void> {
    if (!name.trim() || !command.trim()) return
    const next: McpServerDef[] = [
      ...items.map((i) => ({ ...i })),
      {
        name,
        transport: 'stdio',
        command,
        args: argsStr.trim() ? argsStr.trim().split(/\s+/) : [],
        enabled: true
      }
    ]
    setItems(await api.saveMcp(next))
    setName('')
    setCommand('')
    setArgsStr('')
  }

  return (
    <PanelShell
      title="MCP / Connectors"
      sub="Connect external tools and data via the Model Context Protocol. Their tools become available to the agent."
    >
      <div className="card">
        <h3>Add a connector (stdio)</h3>
        <div className="row" style={{ marginTop: 12 }}>
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="filesystem" />
          </div>
          <div className="field">
            <label>Command</label>
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
          </div>
        </div>
        <div className="field">
          <label>Arguments (space-separated)</label>
          <input value={argsStr} onChange={(e) => setArgsStr(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem ." />
        </div>
        <button className="btn" onClick={add}>
          Add connector
        </button>
      </div>

      {items.length === 0 && <div className="empty">No connectors configured.</div>}
      {items.map((m) => (
        <div className="card" key={m.name}>
          <div className="flex-between">
            <h3>
              {m.name}
              <span className="badge">{m.transport}</span>
              <span className="badge" style={{ color: m.status === 'connected' ? 'var(--green)' : m.status === 'error' ? 'var(--red)' : undefined }}>
                {m.status ?? 'disconnected'}
              </span>
            </h3>
            <div style={{ display: 'flex', gap: 8 }}>
              {m.status === 'connected' ? (
                <button
                  className="btn ghost sm"
                  onClick={async () => {
                    await api.disconnectMcp(m.name)
                    load()
                  }}
                >
                  Disconnect
                </button>
              ) : (
                <button
                  className="btn sm"
                  onClick={async () => {
                    await api.connectMcp(m.name)
                    load()
                  }}
                >
                  Connect
                </button>
              )}
            </div>
          </div>
          <p className="meta">
            {m.command} {(m.args ?? []).join(' ')} {m.url ?? ''}
          </p>
          {m.tools?.length ? <p>tools: {m.tools.join(', ')}</p> : null}
          {m.error ? <p style={{ color: 'var(--red)' }}>{m.error}</p> : null}
        </div>
      ))}
    </PanelShell>
  )
}

// ---- Plugins ----
export function PluginsPanel(): JSX.Element {
  const [items, setItems] = useState<PluginDef[]>([])
  async function load(): Promise<void> {
    setItems(await api.listPlugins())
  }
  useEffect(() => {
    load()
  }, [])
  return (
    <PanelShell title="Plugins" sub="Installable bundles that package skills, commands, subagents, hooks and connectors.">
      {items.length === 0 && <div className="empty">No plugins installed.</div>}
      {items.map((p) => (
        <div className="card" key={p.name}>
          <div className="flex-between">
            <h3>
              {p.name} <span className="badge">v{p.version}</span>
            </h3>
            <Switch
              on={p.enabled}
              onClick={async () => {
                await api.togglePlugin(p.name, !p.enabled)
                load()
              }}
            />
          </div>
          <p>{p.description}</p>
          <p className="meta">
            {p.provides.skills} skills · {p.provides.commands} commands · {p.provides.agents} agents ·{' '}
            {p.provides.hooks} hooks · {p.provides.mcp} connectors
          </p>
        </div>
      ))}
      <p className="sub" style={{ marginTop: 16 }}>
        Drop plugin folders into <code style={{ fontFamily: 'var(--mono)' }}>~/.deepcode/plugins/</code>.
      </p>
    </PanelShell>
  )
}

// ---- Automations ----
export function AutomationsPanel({
  cwd,
  initialPrompt,
  onPrefillUsed
}: {
  cwd?: string
  initialPrompt?: string
  onPrefillUsed?: () => void
}): JSX.Element {
  const [items, setItems] = useState<AutomationDef[]>([])
  const [name, setName] = useState('')
  const [schedule, setSchedule] = useState('0 9 * * *')
  const [prompt, setPrompt] = useState('')
  const [autonomy, setAutonomy] = useState<'safe' | 'full'>('safe')
  const [running, setRunning] = useState<string | null>(null)
  const [runErr, setRunErr] = useState<Record<string, string>>({})

  // "Jetzt ausführen" awaits the run so the button can show progress and surface a rejection,
  // instead of firing a floating promise the user gets no feedback from.
  async function run(id: string): Promise<void> {
    setRunning(id)
    setRunErr((e) => ({ ...e, [id]: '' }))
    try {
      await api.runAutomation(id)
    } catch (e) {
      setRunErr((errs) => ({ ...errs, [id]: String((e as Error).message ?? e) }))
    } finally {
      setRunning(null)
    }
  }

  // "Als Automation speichern" from a chat message pre-fills the form
  useEffect(() => {
    if (initialPrompt) {
      setPrompt(initialPrompt)
      setName(initialPrompt.replace(/\s+/g, ' ').slice(0, 40))
      onPrefillUsed?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt])

  async function load(): Promise<void> {
    setItems(await api.listAutomations())
  }
  useEffect(() => {
    load()
  }, [])

  async function add(): Promise<void> {
    if (!name.trim() || !prompt.trim()) return
    const a: AutomationDef = {
      id: 'auto-' + Date.now(),
      name,
      schedule,
      prompt,
      cwd: cwd || '',
      enabled: true,
      autonomy
    }
    await api.saveAutomation(a)
    setName('')
    setPrompt('')
    load()
  }

  return (
    <PanelShell
      title="Automations"
      sub="Routines that run a prompt on a cron schedule (minute hour day month weekday)."
    >
      <div className="card">
        <h3>New automation</h3>
        <div className="row" style={{ marginTop: 12 }}>
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily test run" />
          </div>
          <div className="field">
            <label>Schedule (cron)</label>
            <input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 9 * * *" />
          </div>
        </div>
        <div className="field">
          <label>Prompt</label>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Run the test suite and summarize failures." />
        </div>
        <div className="field">
          <label>Autonomy (unattended runs)</label>
          <select value={autonomy} onChange={(e) => setAutonomy(e.target.value as 'safe' | 'full')}>
            <option value="safe">Safe — only read-only tools run unattended</option>
            <option value="full">Full — allow file changes and shell commands</option>
          </select>
        </div>
        <button className="btn" onClick={add}>
          Create automation
        </button>
      </div>

      {items.length === 0 && <div className="empty">No automations yet.</div>}
      {items.map((a) => (
        <div className="card" key={a.id}>
          <div className="flex-between">
            <h3>
              {a.name} <span className="badge">{a.schedule}</span>
              <span className="badge" style={{ color: a.autonomy === 'full' ? 'var(--yellow)' : undefined }}>
                {a.autonomy === 'full' ? 'full access' : 'safe'}
              </span>
            </h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Switch
                on={a.enabled}
                onClick={async () => {
                  await api.saveAutomation({ ...a, enabled: !a.enabled })
                  load()
                }}
              />
              <button className="btn ghost sm" disabled={running === a.id} onClick={() => run(a.id)}>
                {running === a.id ? 'Läuft…' : 'Run now'}
              </button>
              <button
                className="btn danger sm"
                onClick={async () => {
                  if (!window.confirm('Automation wirklich löschen?')) return
                  await api.deleteAutomation(a.id)
                  load()
                }}
              >
                Delete
              </button>
            </div>
          </div>
          <p>{a.prompt}</p>
          <p className="meta">{a.cwd || '(no working dir)'}</p>
          {runErr[a.id] && <p style={{ color: 'var(--red)', marginTop: 4 }}>⚠ {runErr[a.id]}</p>}
        </div>
      ))}
    </PanelShell>
  )
}
