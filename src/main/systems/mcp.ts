import { existsSync, readFileSync } from 'fs'
import { PATHS } from '../paths'
import { atomicWriteJson } from '../atomic'
import { safeEnv } from '../audit'
import { McpServerDef, ToolResult } from '@shared/types'
import { Tool, ok, fail } from '../agent/tools/types'
import { pluginMcpServers } from './plugins'

// A hung MCP server must NEVER block a turn forever. Bound every call by the turn's abort signal
// (so Stop/Escape interrupts it instantly) AND a hard wall-clock timeout (so a server that just
// never answers still releases the turn). 2 min covers legitimately slow tools; Stop is immediate.
export const MCP_CALL_TIMEOUT_MS = 120_000

// Run one MCP tool call with abort + timeout wired in, and map the result to a ToolResult. Exported
// (and client typed structurally) so the timeout/abort/error behaviour is unit-testable without a
// live MCP server. Without this, `client.callTool` had no signal and no timeout — a hung server
// (e.g. sequential-thinking) left the await pending forever, so the turn never ended and Stop did
// nothing (the engine was blocked inside the unwinding-incapable await).
export async function callMcpTool(
  client: { callTool: (params: unknown, schema: unknown, opts: unknown) => Promise<any> },
  name: string,
  args: unknown,
  signal: AbortSignal | undefined
): Promise<ToolResult> {
  try {
    const res = await client.callTool(
      { name, arguments: args ?? {} },
      undefined, // default result schema
      { signal, timeout: MCP_CALL_TIMEOUT_MS, maxTotalTimeout: MCP_CALL_TIMEOUT_MS }
    )
    const text = (res.content ?? [])
      .map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`))
      .join('\n')
    return res.isError ? fail(text || 'MCP tool error') : ok(text || '(no output)')
  } catch (e) {
    if (signal?.aborted || (e as Error).name === 'AbortError') return fail(`MCP-Aufruf „${name}" abgebrochen.`)
    return fail(`MCP call failed: ${(e as Error).message}`)
  }
}

// MCP (Model Context Protocol) connector manager. Reads server definitions from
// ~/.deepcode/mcp.json, connects over stdio / SSE / HTTP, and surfaces each
// remote tool as a local Tool the agent can call.
//
// mcp.json format (Claude-compatible):
//   { "mcpServers": { "name": { "command": "npx", "args": ["-y", "pkg"], "env": {} } } }

interface McpConfigFile {
  mcpServers?: Record<string, RawServer>
}
interface RawServer {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  transport?: string
  enabled?: boolean
}

interface Connection {
  def: McpServerDef
  client: any
  tools: Tool[]
}

export class McpManager {
  private connections = new Map<string, Connection>()

  loadConfig(): McpServerDef[] {
    const defs: McpServerDef[] = []
    if (existsSync(PATHS.mcp)) {
      try {
        const json = JSON.parse(readFileSync(PATHS.mcp, 'utf8')) as McpConfigFile
        const servers = json.mcpServers ?? (json as Record<string, RawServer>)
        for (const [name, cfg] of Object.entries(servers)) {
          defs.push({
            name,
            transport: cfg.url ? (cfg.transport as any) || 'sse' : 'stdio',
            command: cfg.command,
            args: cfg.args,
            env: cfg.env,
            url: cfg.url,
            enabled: cfg.enabled !== false
          })
        }
      } catch {
        /* ignore malformed config */
      }
    }
    defs.push(...pluginMcpServers())
    // annotate with live status
    return defs.map((d) => {
      const conn = this.connections.get(d.name)
      return conn
        ? { ...d, status: 'connected', tools: conn.tools.map((t) => t.name) }
        : { ...d, status: 'disconnected' }
    })
  }

  saveConfig(defs: McpServerDef[]): void {
    const mcpServers: Record<string, RawServer> = {}
    for (const d of defs) {
      mcpServers[d.name] = {
        command: d.command,
        args: d.args,
        env: d.env,
        url: d.url,
        transport: d.transport,
        enabled: d.enabled
      }
    }
    atomicWriteJson(PATHS.mcp, { mcpServers })
  }

  listStatus(): McpServerDef[] {
    return this.loadConfig()
  }

  getTools(): Tool[] {
    const tools: Tool[] = []
    for (const conn of this.connections.values()) tools.push(...conn.tools)
    return tools
  }

  async connect(name: string): Promise<McpServerDef> {
    const def = this.loadConfig().find((d) => d.name === name)
    if (!def) throw new Error(`MCP server "${name}" not found in config`)
    if (this.connections.has(name)) return { ...def, status: 'connected' }

    // Dynamic import keeps the SDK out of the startup path.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    let transport: any
    if (def.transport === 'stdio') {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
      // Windows: npx/uvx etc. are .cmd shims — direct spawn fails with ENOENT.
      // Routing through cmd.exe resolves anything on PATH reliably.
      const isWin = process.platform === 'win32'
      const command = isWin ? 'cmd.exe' : def.command!
      const args = isWin ? ['/c', def.command!, ...(def.args ?? [])] : (def.args ?? [])
      transport = new StdioClientTransport({
        command,
        args,
        env: safeEnv(def.env ?? {}) as Record<string, string>
      })
    } else if (def.transport === 'sse') {
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
      transport = new SSEClientTransport(new URL(def.url!))
    } else {
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      )
      transport = new StreamableHTTPClientTransport(new URL(def.url!))
    }

    const client = new Client({ name: 'deepcode', version: '0.1.0' }, { capabilities: {} })
    await client.connect(transport)
    const listed = await client.listTools()

    const tools: Tool[] = (listed.tools ?? []).map((mt: any) => this.wrapTool(name, client, mt))
    this.connections.set(name, { def, client, tools })
    return { ...def, status: 'connected', tools: tools.map((t) => t.name) }
  }

  private wrapTool(server: string, client: any, mt: any): Tool {
    return {
      name: `mcp__${server}__${mt.name}`,
      description: mt.description || `MCP tool ${mt.name} from ${server}`,
      parameters: mt.inputSchema ?? { type: 'object', properties: {} },
      permission: 'write', // remote effects are gated like writes
      summarize: () => `MCP ${server}: ${mt.name}`,
      // pass ctx.signal so Stop/Escape interrupts the call, and rely on callMcpTool's hard timeout
      // so a hung server can't strand the turn (the bug this fixes).
      execute: (args, ctx) => callMcpTool(client, mt.name, args, ctx?.signal)
    }
  }

  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name)
    if (!conn) return
    try {
      await conn.client.close()
    } catch {
      /* ignore */
    }
    this.connections.delete(name)
  }

  async connectAllEnabled(): Promise<void> {
    for (const def of this.loadConfig()) {
      if (def.enabled) {
        try {
          await this.connect(def.name)
        } catch (e) {
          console.error(`MCP connect failed for ${def.name}:`, (e as Error).message)
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const name of [...this.connections.keys()]) await this.disconnect(name)
  }
}

export const mcpManager = new McpManager()
