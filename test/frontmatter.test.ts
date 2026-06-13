import { describe, it, expect } from 'vitest'
import { parseFrontmatter, str } from '../src/main/systems/frontmatter'

describe('parseFrontmatter scalar quoting', () => {
  it('JSON-unescapes a double-quoted value (embedded quotes survive the round-trip)', () => {
    // mirrors how saveMemory writes: description: ${JSON.stringify(...)}
    const desc = 'User prefers "safe" mode for git'
    const text = `---\nname: x\ndescription: ${JSON.stringify(desc)}\ntype: feedback\n---\n\nbody`
    const { data, body } = parseFrontmatter(text)
    expect(str(data.description)).toBe(desc) // not 'User prefers \\"safe\\" mode...'
    expect(body.trim()).toBe('body')
  })

  it('still strips simple single/double quotes and bare values', () => {
    expect(str(parseFrontmatter(`---\na: 'hi'\n---\n`).data.a)).toBe('hi')
    expect(str(parseFrontmatter(`---\na: plain\n---\n`).data.a)).toBe('plain')
  })

  it('parses array values', () => {
    const { data } = parseFrontmatter(`---\ntools: [read, write, grep]\n---\n`)
    expect(data.tools).toEqual(['read', 'write', 'grep'])
  })
})
