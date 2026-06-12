import type { DeepCodeApi } from '../../shared/api'

declare global {
  interface Window {
    deepcode: DeepCodeApi
  }
}

export {}
