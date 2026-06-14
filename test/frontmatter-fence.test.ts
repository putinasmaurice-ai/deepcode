import { describe, it, expect } from 'vitest'
import { parseFrontmatter, str } from '../src/main/systems/frontmatter'

describe('parseFrontmatter closing fence', () => {
  it('does not stop at a --- horizontal rule inside the body', () => {
    const text = `---\nname: x\n---\n\nintro\n\n---\n\nmore`
    const { data, body } = parseFrontmatter(text)
    expect(str(data.name)).toBe('x')
    // the body keeps its horizontal rule intact
    expect(body).toBe('intro\n\n---\n\nmore')
  })

  it('keeps a frontmatter value that contains --- (not treated as the fence)', () => {
    const desc = 'a --- b'
    const text = `---\ndescription: ${JSON.stringify(desc)}\nname: y\n---\nbody`
    const { data, body } = parseFrontmatter(text)
    expect(str(data.description)).toBe(desc)
    expect(str(data.name)).toBe('y')
    expect(body.trim()).toBe('body')
  })

  it('treats a fence with trailing whitespace as a valid close', () => {
    const { data, body } = parseFrontmatter(`---\na: 1\n--- \nbody`)
    expect(str(data.a)).toBe('1')
    expect(body.trim()).toBe('body')
  })

  it('does not treat ---- or ---foo as the closing fence', () => {
    const text = `---\na: 1\n----\nstill yaml? no\n---\nbody`
    const { data, body } = parseFrontmatter(text)
    expect(str(data.a)).toBe('1')
    expect(body.trim()).toBe('body')
  })
})
