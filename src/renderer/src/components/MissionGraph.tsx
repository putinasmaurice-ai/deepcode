import { useMemo } from 'react'
import '@xyflow/react/dist/style.css' // co-located so it loads only with the (lazy) graph
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps
} from '@xyflow/react'
import { NeonEdge } from './workflow/NeonEdge'

// Locked v2 contract shapes (see src/shared/types.ts). Mirrored here — like MissionPanel — so the
// graph compiles independently of the parallel main-process build; the runtime objects come over
// IPC inside the live `mission` prop. deps/branch/kind are the v2 additions this view renders.
interface MissionTask {
  id: string
  title: string
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  deps?: string[]
  branch?: string
  kind?: 'task' | 'remediation'
  commit?: string
  cost?: number
}
interface Mission {
  id: string
  goal: string
  tasks: MissionTask[]
}

// status → node modifier class. Reuses the workflow neon palette: running pulses, done = green
// flash, failed = red shake (defined as .mission-graph-node.st-* in styles.css, mirroring .wf-node).
const STATUS_ICON: Record<MissionTask['status'], string> = {
  pending: '⏳',
  running: '◐',
  done: '✅',
  failed: '❌'
}

interface MgData extends Record<string, unknown> {
  task: MissionTask
  index: number
}

function MgNodeView({ data }: NodeProps): JSX.Element {
  const { task, index } = data as MgData
  const remediation = task.kind === 'remediation'
  return (
    <div
      className={'mission-graph-node st-' + task.status + (remediation ? ' remediation' : '')}
      data-kind={remediation ? 'remediation' : 'task'}
      title={task.title}
    >
      <Handle type="target" position={Position.Left} />
      <div className="mission-graph-node-head">
        <span className="mission-graph-ic">{STATUS_ICON[task.status]}</span>
        <span className="mission-graph-ttl">
          {index + 1}. {task.title}
        </span>
        {remediation && <span className="mission-graph-tag">↺ Reparatur</span>}
      </div>
      {/* once verified the commit sha is the proof the gate was green — surface it on the node */}
      {task.commit && (
        <div className="mission-graph-meta" title={task.branch ? `Branch: ${task.branch}` : undefined}>
          ⎇ {task.commit.slice(0, 8)}
          {task.cost ? ` · $${task.cost.toFixed(2)}` : ''}
        </div>
      )}
      {!task.commit && task.attempts > 1 && (
        <div className="mission-graph-meta">{task.attempts} Versuche</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

// edge status mirrored from the tasks: an edge into a running task glows (the active route), into a
// done task it reads green, into a failed task red. Pure derivation from the live mission prop.
function edgeStatus(target: MissionTask): 'running' | 'done' | 'failed' | undefined {
  if (target.status === 'running') return 'running'
  if (target.status === 'done') return 'done'
  if (target.status === 'failed') return 'failed'
  return undefined
}

// Topological depth = longest dependency chain into a task → its column. Computed with a bounded
// relaxation pass (V iterations max) so a malformed/cyclic DAG can never infinite-loop the layout
// (the overseer fails such a mission closed; this view must still render without hanging). Tasks
// referencing a missing dep id simply ignore it here — depth falls back to their own roots.
function computeDepths(tasks: MissionTask[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const depth = new Map<string, number>(tasks.map((t) => [t.id, 0]))
  for (let pass = 0; pass < tasks.length; pass++) {
    let changed = false
    for (const t of tasks) {
      let d = 0
      for (const dep of t.deps ?? []) {
        if (byId.has(dep)) d = Math.max(d, (depth.get(dep) ?? 0) + 1)
      }
      if (d !== depth.get(t.id)) {
        depth.set(t.id, d)
        changed = true
      }
    }
    if (!changed) break
  }
  return depth
}

const COL_W = 240
const ROW_H = 116

export function MissionGraph({ mission }: { mission: Mission }): JSX.Element {
  const nodeTypes = useMemo(() => ({ mg: MgNodeView }), [])
  const edgeTypes = useMemo(() => ({ neon: NeonEdge }), [])

  // recompute layout + edges purely from the mission prop. Memoized on the fields that actually
  // affect the picture (ids, deps, status, commit) so a live status flip re-renders, but unrelated
  // mission churn doesn't thrash. Stable column-by-depth, rows stacked within a column.
  const sig = mission.tasks
    .map((t) => `${t.id}:${t.status}:${t.commit ?? ''}:${(t.deps ?? []).join(',')}:${t.kind ?? ''}`)
    .join('|')

  const { nodes, edges } = useMemo(() => {
    const tasks = mission.tasks
    const depth = computeDepths(tasks)
    const rowInCol = new Map<number, number>()
    const ns: Node<MgData>[] = tasks.map((t, i) => {
      const col = depth.get(t.id) ?? 0
      const row = rowInCol.get(col) ?? 0
      rowInCol.set(col, row + 1)
      return {
        id: t.id,
        type: 'mg',
        position: { x: col * COL_W, y: row * ROW_H },
        data: { task: t, index: i },
        draggable: false,
        connectable: false,
        selectable: false
      }
    })
    const have = new Set(tasks.map((t) => t.id))
    const es: Edge[] = []
    for (const t of tasks) {
      for (const dep of t.deps ?? []) {
        if (!have.has(dep)) continue // skip a dangling dep id — keep the canvas coherent
        es.push({
          id: `${dep}->${t.id}`,
          source: dep,
          target: t.id,
          type: 'neon',
          data: { status: edgeStatus(t) }
        })
      }
    }
    return { nodes: ns, edges: es }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])

  if (mission.tasks.length === 0) {
    return (
      <div className="mission-graph-empty">
        Noch kein Plan — erzeuge oben einen Plan, um den Aufgaben-Graphen zu sehen.
      </div>
    )
  }

  return (
    <div className="mission-graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        fitView
        minZoom={0.3}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
