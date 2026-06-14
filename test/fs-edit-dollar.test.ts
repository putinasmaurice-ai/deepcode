import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { editTool, applyPatchTool } from '../src/main/agent/tools/fs'
import type { ToolContext } from '../src/main/agent/tools/types'

// H2 — new_string is DATA, not a replacement template. $&, $1..$9, $`, $' and $$
// must land in the file verbatim; String.replace would expand them and corrupt it.
let dir: string

function ctx(): ToolContext {
  return { cwd: dir, signal: new AbortController().signal }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fs-edit-dollar-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('edit_file writes $-patterns literally', () => {
  it('keeps $& and $1 verbatim (single replace)', async () => {
    const f = join(dir, 'a.txt')
    writeFileSync(f, 'before MARK after', 'utf8')
    const res = await editTool.execute(
      { path: f, old_string: 'MARK', new_string: 'cost $& and $1 then $$ done' },
      ctx()
    )
    expect(res.ok).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('before cost $& and $1 then $$ done after')
  })

  it('keeps $` and $\' verbatim (single replace)', async () => {
    const f = join(dir, 'b.txt')
    writeFileSync(f, 'x MARK y', 'utf8')
    await editTool.execute(
      { path: f, old_string: 'MARK', new_string: "lead $` tail $'" },
      ctx()
    )
    expect(readFileSync(f, 'utf8')).toBe("x lead $` tail $' y")
  })
})

describe('apply_patch writes $-patterns literally', () => {
  it('keeps $& and $1 verbatim in a single-edit op', async () => {
    const f = join(dir, 'c.txt')
    writeFileSync(f, 'before MARK after', 'utf8')
    const res = await applyPatchTool.execute(
      { ops: [{ path: f, type: 'edit', old_string: 'MARK', new_string: 'cost $& and $1 then $$ done' }] },
      ctx()
    )
    expect(res.ok).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('before cost $& and $1 then $$ done after')
  })
})
