import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

// Image bytes and natural size for embedding in documents and decks, without an image library.

export type ImageKind = 'png' | 'jpg' | 'gif' | 'bmp'

export interface ImageInfo {
  data: Buffer
  type: ImageKind
  width: number
  height: number
}

export function imageType(b: Buffer): ImageKind | undefined {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'jpg'
  if (b.length > 6 && b.subarray(0, 3).toString('latin1') === 'GIF') return 'gif'
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  return undefined
}

/** Pixel size of a PNG, JPEG, GIF or BMP image. */
export function imageSize(b: Buffer): { width: number; height: number } | undefined {
  const t = imageType(b)
  if (t === 'png' && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (t === 'gif') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  if (t === 'bmp') return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) }
  if (t === 'jpg') {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const marker = b[i + 1]
      const len = b.readUInt16BE(i + 2)
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
      i += 2 + len
    }
  }
  return undefined
}

/** Reads an image from a data: URI or a file path (relative paths resolve against baseDir). */
export function loadImage(src: string, baseDir?: string, read?: (path: string) => Buffer): ImageInfo {
  let data: Buffer
  const m = /^data:image\/[\w+.-]+;base64,(.+)$/i.exec(src.trim())
  if (m) data = Buffer.from(m[1], 'base64')
  else if (/^https?:\/\//i.test(src)) throw new Error(`Image "${src.slice(0, 80)}" is a web address; download it into the workspace first and use the file path.`)
  else if (read) data = read(src)
  else {
    const p = isAbsolute(src) || !baseDir ? src : resolve(baseDir, src)
    if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`Image not found: ${src}`)
    if (statSync(p).size > 25_000_000) throw new Error(`Image ${src} is larger than 25 MB.`)
    data = readFileSync(p)
  }
  const type = imageType(data)
  if (!type) throw new Error(`"${src.slice(0, 80)}" is not a PNG, JPEG, GIF or BMP image.`)
  const size = imageSize(data) ?? { width: 800, height: 600 }
  return { data, type, ...size }
}

/** Scales (w, h) to fit inside (maxW, maxH), keeping the aspect ratio and never enlarging. */
export function fitBox(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  const s = Math.min(1, maxW / Math.max(1, w), maxH / Math.max(1, h))
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }
}
