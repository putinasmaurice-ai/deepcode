import { getBezierPath, type EdgeProps } from '@xyflow/react'

// edge state mirrored from the executor onto edge.data by WorkflowEditor's live handler.
// 'failed' is mapped to the is-error modifier so it matches the locked CSS contract.
type EdgeStatus = 'running' | 'done' | 'failed' | 'error'

// CSS `animation: none` cannot disable an SVG SMIL <animateMotion>; that engine is
// independent of CSS. So we gate the traveling packet in JS to honor reduced-motion.
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

// A glowing neon connection: the bezier is drawn twice — a dim base + a bright glow whose
// stroke-dashoffset is animated in CSS (@keyframes wf-flow) to read as flowing energy.
// During a node's execution the incoming edge carries .is-running and a traveling packet
// (an SVG circle following the path via <animateMotion>) lights up the active route.
export function NeonEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd
}: EdgeProps): JSX.Element {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const raw = (data as { status?: EdgeStatus } | undefined)?.status
  const mod = raw === 'failed' ? 'error' : raw // contract: is-error not is-failed
  const cls = 'wf-edge-group' + (mod ? ' is-' + mod : '')
  const pathId = 'wf-edge-path-' + id
  // only mount the SMIL packet when actually running and motion is allowed
  const showPacket = mod === 'running' && !prefersReducedMotion()

  return (
    <g className={cls}>
      {/* a hidden geometry path the packet's <mpath> references */}
      <path id={pathId} d={path} fill="none" stroke="none" />
      <path className="wf-edge-base" d={path} fill="none" markerEnd={markerEnd} />
      <path className="wf-edge-glow" d={path} fill="none" />
      {showPacket && (
        <circle className="wf-edge-packet" r={3.5}>
          <animateMotion dur="1.1s" repeatCount="indefinite">
            <mpath href={'#' + pathId} />
          </animateMotion>
        </circle>
      )}
    </g>
  )
}
