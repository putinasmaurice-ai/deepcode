import { describe, it, expect } from 'vitest'
import { previewProbeTool } from '../src/main/agent/tools/preview-probe'
import type { ToolContext } from '../src/main/agent/tools/types'

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, ...over }
}

describe('preview_probe tool', () => {
  it('refuses under an unattended run (defense-in-depth beside screenUnattendedCall)', async () => {
    const r = await previewProbeTool.execute({ action: 'screenshot' }, ctx({ unattended: true }))
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/unbeaufsichtigt/i)
  })

  it('returns a clear error when no preview is attached', async () => {
    // no <webview> attached in a test process → getPreviewGuest() is null
    const r = await previewProbeTool.execute({ action: 'screenshot' }, ctx())
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/Keine Live-Vorschau/i)
  })

  it('has read permission and a summarize label', () => {
    expect(previewProbeTool.permission).toBe('read')
    expect(previewProbeTool.summarize?.({ action: 'click', selector: 'button' })).toContain('click')
  })
})
