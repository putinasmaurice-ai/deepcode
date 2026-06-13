import { describe, it, expect } from 'vitest'
import { getWorkflow, saveWorkflow, deleteWorkflow } from '../src/main/workflows/store'
import type { WorkflowDef } from '../src/shared/types'

// The workflow id becomes part of a filename (workflows/<id>.json). A traversal id must
// be rejected BEFORE any fs op so it can't read/write/unlink arbitrary .json files
// (settings, sessions) outside the workflows directory.
describe('workflow store id validation', () => {
  const evil = ['../../settings', '..\\..\\settings', 'a/b', 'a\\b', 'foo.bar', '', '.', '..']

  it('rejects traversal / unsafe ids on read', () => {
    for (const id of evil) {
      expect(() => getWorkflow(id)).toThrow(/invalid workflow id/)
    }
  })

  it('rejects traversal / unsafe ids on delete', () => {
    for (const id of evil) {
      expect(() => deleteWorkflow(id)).toThrow(/invalid workflow id/)
    }
  })

  it('rejects traversal / unsafe ids on save', () => {
    const def = { id: '../../settings', name: 'x', nodes: [], edges: [], createdAt: 0, updatedAt: 0 } as WorkflowDef
    expect(() => saveWorkflow(def)).toThrow(/invalid workflow id/)
  })

  it('accepts plain slug ids', () => {
    // uid() / randomUUID() shapes — no fs assertion here, just that the guard passes
    for (const id of ['wf_abc123', 'a-b-c', 'ABC_def-123', '0f8c2a1b-1234-4abc-9def-000011112222']) {
      expect(() => getWorkflow(id)).not.toThrow()
    }
  })
})
