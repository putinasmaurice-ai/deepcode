import { describe, it, expect } from 'vitest'
import { detectFramework, buildReporterCommand, parseReport, focusFeedback } from '../src/shared/test-report'
import { isTestFile } from '../src/main/agent/verify-synth'

describe('detectFramework', () => {
  it('identifies the runner from the command', () => {
    expect(detectFramework('npx vitest run')).toBe('vitest')
    expect(detectFramework('jest --watch=false')).toBe('jest')
    expect(detectFramework('pytest -q')).toBe('pytest')
    expect(detectFramework('mocha test/')).toBe('mocha')
    expect(detectFramework('npm test')).toBeNull() // generic — no runner named
  })
})

describe('buildReporterCommand', () => {
  it('appends the right JSON reporter flag per framework', () => {
    expect(buildReporterCommand('npx vitest run', 'vitest', '/tmp/r.json')).toContain('--reporter=json --outputFile=')
    expect(buildReporterCommand('npx jest', 'jest', '/tmp/r.json')).toContain('--json --outputFile=')
    expect(buildReporterCommand('pytest', 'pytest', '/tmp/r.json')).toContain('--json-report --json-report-file=')
  })
  it('honours the npm -- forwarding rule', () => {
    // no existing -- → add one
    expect(buildReporterCommand('npm test', 'vitest', '/tmp/r.json')).toMatch(/npm test -- --reporter=json/)
    // existing -- → append after it (no second --)
    const c = buildReporterCommand('npm test -- --run', 'vitest', '/tmp/r.json')
    expect(c).toMatch(/npm test -- --run --reporter=json/)
    expect(c.match(/ -- /g)?.length).toBe(1)
  })
})

describe('parseReport', () => {
  it('parses a vitest/jest report with a failing test', () => {
    const json = JSON.stringify({
      numTotalTests: 2,
      numPassedTests: 1,
      testResults: [
        {
          name: '/p/foo.test.ts',
          assertionResults: [
            { fullName: 'adds', status: 'passed' },
            { fullName: 'subtracts', status: 'failed', failureMessages: ['expected 1 got 2'] }
          ]
        }
      ]
    })
    const r = parseReport('vitest', json)!
    expect(r.ok).toBe(false)
    expect(r.total).toBe(2)
    expect(r.passed).toBe(1)
    expect(r.failures).toEqual([{ name: 'subtracts', file: '/p/foo.test.ts', message: 'expected 1 got 2' }])
  })
  it('parses a pytest json-report', () => {
    const json = JSON.stringify({
      summary: { passed: 1, total: 2 },
      tests: [
        { nodeid: 'test_x.py::test_a', outcome: 'passed' },
        { nodeid: 'test_x.py::test_b', outcome: 'failed', call: { crash: { message: 'AssertionError' } } }
      ]
    })
    const r = parseReport('pytest', json)!
    expect(r.ok).toBe(false)
    expect(r.failures[0]).toEqual({ name: 'test_x.py::test_b', file: 'test_x.py', message: 'AssertionError' })
  })
  it('parses a mocha report', () => {
    const json = JSON.stringify({ stats: { passes: 1, tests: 2 }, failures: [{ fullTitle: 'thing works', file: '/p/t.js', err: { message: 'boom' } }] })
    const r = parseReport('mocha', json)!
    expect(r.failures[0].name).toBe('thing works')
    expect(r.ok).toBe(false)
  })
  it('returns null on malformed / empty json so the caller falls back', () => {
    expect(parseReport('vitest', 'not json')).toBeNull()
    expect(parseReport('vitest', '{}')).toBeNull()
  })
})

describe('focusFeedback', () => {
  it('builds a compact prompt naming the failing tests', () => {
    const fb = focusFeedback({ ok: false, total: 3, passed: 1, failures: [
      { name: 'subtracts', file: 'foo.test.ts', message: 'expected 1 got 2' },
      { name: 'divides', message: 'NaN' }
    ] })
    expect(fb).toContain('1/3 grün')
    expect(fb).toContain('subtracts')
    expect(fb).toContain('expected 1 got 2')
    expect(fb).toContain('divides')
  })
})

describe('isTestFile', () => {
  it('recognizes JS/TS and Python test files', () => {
    expect(isTestFile('src/foo.test.ts')).toBe(true)
    expect(isTestFile('src/foo.spec.jsx')).toBe(true)
    expect(isTestFile('tests/test_foo.py')).toBe(true)
    expect(isTestFile('tests/foo_test.py')).toBe(true)
    expect(isTestFile('src/foo.ts')).toBe(false)
    expect(isTestFile('src/util.py')).toBe(false)
  })
})
