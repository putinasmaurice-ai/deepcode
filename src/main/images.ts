import { existsSync, readFileSync, statSync } from 'fs'
import { extname } from 'path'

// Reads an image file into a data: URI for vision models. Capped at ~12MB.

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.test(p)
}

export function imageToDataUri(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    if (statSync(path).size > 12_000_000) return null
    const mime = MIME[extname(path).toLowerCase()] || 'image/png'
    const b64 = readFileSync(path).toString('base64')
    return `data:${mime};base64,${b64}`
  } catch {
    return null
  }
}
