import type { DeepCodeApi } from '../../preload'

declare global {
  interface Window {
    deepcode: DeepCodeApi
  }
}

export {}
