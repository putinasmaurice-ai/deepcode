import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from './paths'

// Rolling history of recent TURN outcomes (cost, tokens, duration), used to forecast
// what the next turn will roughly cost/take — grounded in the user's own usage, not a
// guess. Persisted as a small ring buffer in ~/.deepcode/turn-samples.json.

export interface TurnSample {
  cost: number
  tokens: number
  durationMs: number
  model: string
  at: number
}

export interface Forecast {
  count: number
  avgCost: number
  avgTokens: number
  avgDurationMs: number
}

const FILE = join(PATHS.root, 'turn-samples.json')
const MAX = 60
let cache: TurnSample[] | null = null

function load(): TurnSample[] {
  if (cache) return cache
  if (existsSync(FILE)) {
    try {
      const arr = JSON.parse(readFileSync(FILE, 'utf8'))
      // validate each element so a tampered/odd entry can't yield NaN averages or
      // throw in forecastTurn's reduce (the cast alone would defeat the type guard)
      cache = Array.isArray(arr)
        ? (arr as unknown[]).filter(
            (s): s is TurnSample =>
              !!s &&
              typeof s === 'object' &&
              Number.isFinite((s as TurnSample).cost) &&
              Number.isFinite((s as TurnSample).tokens) &&
              Number.isFinite((s as TurnSample).durationMs)
          )
        : []
      return cache
    } catch {
      /* fall through */
    }
  }
  cache = []
  return cache
}

export function recordTurnSample(s: TurnSample): void {
  const list = load()
  list.push(s)
  if (list.length > MAX) list.splice(0, list.length - MAX)
  try {
    writeFileSync(FILE, JSON.stringify(list), 'utf8')
  } catch {
    /* best effort */
  }
}

// Forecast from the most recent samples (optionally only those for a given model,
// falling back to all when too few model-specific samples exist).
export function forecastTurn(model?: string): Forecast {
  const all = load()
  const scoped = model ? all.filter((s) => s.model === model) : all
  const use = scoped.length >= 3 ? scoped : all
  if (!use.length) return { count: 0, avgCost: 0, avgTokens: 0, avgDurationMs: 0 }
  const sum = use.reduce(
    (a, s) => ({ cost: a.cost + s.cost, tokens: a.tokens + s.tokens, dur: a.dur + s.durationMs }),
    { cost: 0, tokens: 0, dur: 0 }
  )
  const n = use.length
  return {
    count: n,
    avgCost: sum.cost / n,
    avgTokens: sum.tokens / n,
    avgDurationMs: sum.dur / n
  }
}
