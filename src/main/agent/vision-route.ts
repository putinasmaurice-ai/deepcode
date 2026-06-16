// Vision model routing — pure, so the security-critical "LOKAL never leaks image bytes to the
// cloud" invariant is unit-testable in isolation from the engine + network. DeepSeek is blind, so
// an attached image is first DESCRIBED by a vision model; this decides WHICH model and guarantees
// that selecting LOKAL (or the no-key online fallback) always carries a routable `local:` prefix —
// a bare/empty/`google:`-typed name would otherwise fall through to the DeepSeek text endpoint and
// ship the raw image bytes to the cloud.

export interface VisionRouteInput {
  visionMode: string | undefined // 'online' | 'local' (anything != 'online' is treated as local)
  visionModel: string | undefined // the configured LOKAL model id (Ollama)
  onlineVisionModel: string | undefined // the configured ONLINE model id (Gemini)
  hasGoogleKey: boolean
}

export interface VisionRoute {
  modelId: string // routable id: 'google:<m>' for Gemini, 'local:<m>' for Ollama
  label: string // human label for the status line
  usedLocalFallback: boolean // online was requested but no key → fell back to local
}

// Coerce a LOKAL vision model id to ALWAYS carry a 'local:' prefix (route to Ollama), even if the
// user typed a bare name or mistyped a 'google:' id into the local field — so LOKAL can never
// silently send image bytes to the Google cloud.
export function localVisionId(visionModel: string | undefined): string {
  const vm = (visionModel || 'local:qwen2.5vl:7b').trim() || 'local:qwen2.5vl:7b'
  return vm.startsWith('local:') ? vm : `local:${vm.replace(/^google:/, '')}`
}

export function chooseVisionModel(input: VisionRouteInput): VisionRoute {
  const online = input.visionMode === 'online'
  if (online && input.hasGoogleKey) {
    const vm = input.onlineVisionModel?.trim() || 'gemini-2.5-flash-lite'
    return { modelId: `google:${vm}`, label: `Gemini (${vm})`, usedLocalFallback: false }
  }
  if (online && !input.hasGoogleKey) {
    return { modelId: localVisionId(input.visionModel), label: 'lokal (kein Google-Key)', usedLocalFallback: true }
  }
  const modelId = localVisionId(input.visionModel)
  return { modelId, label: `lokal (${modelId.replace('local:', '')})`, usedLocalFallback: false }
}
