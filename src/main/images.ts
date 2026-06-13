import { existsSync, readFileSync, statSync } from 'fs'

// Reads an image file into a data: URI for vision models. Capped at ~12MB.

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.test(p)
}

// Sniff the leading magic bytes so only ACTUAL image files are returned. This stops
// imageDataUri (renderer-reachable, no cwd confinement) from being abused to base64-
// exfiltrate arbitrary non-image files (ssh keys, .env, cookie DBs, …).
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  return null
}

export function imageToDataUri(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    if (statSync(path).size > 12_000_000) return null
    const buf = readFileSync(path)
    // trust the bytes, not the extension — reject anything that isn't a real image
    const mime = sniffImageMime(buf)
    if (!mime) return null
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
