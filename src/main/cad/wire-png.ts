import { deflateSync } from 'node:zlib'

// Wireframe pictures of a model for the agent to look at, drawn from its edges as 3D polylines (FreeCAD's
// command-line build has no GUI to take screenshots). Orthographic views like CAD's named views: top looks
// down Z, front looks along +Y (X right, Z up), right looks along -X, isometric is the standard 30° view.
// Output is a small grayscale PNG, encoded here (zlib from Node, CRC-32 per the PNG spec).

export type WireView = 'isometric' | 'top' | 'front' | 'right'
type P3 = [number, number, number]

const C30 = Math.cos(Math.PI / 6), S30 = Math.sin(Math.PI / 6)
const PROJECT: Record<WireView, (p: P3) => [number, number]> = {
  top: ([x, y]) => [x, y],
  front: ([x, , z]) => [x, z],
  right: ([, y, z]) => [y, z],
  isometric: ([x, y, z]) => [(x - y) * C30, z + (x + y) * S30]
}

let CRC: Uint32Array | undefined
function crc32(buf: Buffer): number {
  if (!CRC) {
    CRC = new Uint32Array(256)
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0 }
  }
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** An 8-bit grayscale PNG from a row-major pixel buffer. */
export function encodePng(gray: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; Buffer.from(gray.buffer, gray.byteOffset + y * w, w).copy(raw, y * (w + 1) + 1) }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** Draws the polylines in one view, fitted with a margin; returns a PNG. */
export function wireframePng(polylines: P3[][], view: WireView, w = 640, h = 480): Buffer {
  const img = new Uint8Array(w * h).fill(255)
  const proj = polylines.map((pl) => pl.map(PROJECT[view]))
  const pts = proj.flat()
  if (!pts.length) return encodePng(img, w, h)
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const m = 24
  const s = Math.min((w - 2 * m) / Math.max(1e-9, maxX - minX), (h - 2 * m) / Math.max(1e-9, maxY - minY))
  const ox = (w - (maxX - minX) * s) / 2, oy = (h - (maxY - minY) * s) / 2
  const px = (p: [number, number]): [number, number] => [Math.round(ox + (p[0] - minX) * s), Math.round(h - (oy + (p[1] - minY) * s))]
  const plot = (x: number, y: number): void => { if (x >= 0 && y >= 0 && x < w && y < h) img[y * w + x] = 30 }
  for (const pl of proj) {
    for (let i = 1; i < pl.length; i++) {
      let [x0, y0] = px(pl[i - 1])
      const [x1, y1] = px(pl[i])
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
      let err = dx + dy
      for (let n = 0; n < 4 * (w + h); n++) {
        plot(x0, y0)
        if (x0 === x1 && y0 === y1) break
        const e2 = 2 * err
        if (e2 >= dy) { err += dy; x0 += sx }
        if (e2 <= dx) { err += dx; y0 += sy }
      }
    }
  }
  return encodePng(img, w, h)
}

/** Data URLs of the requested views, for the model to look at. */
export function wireframeImages(polylines: P3[][] | undefined, views: WireView[] = ['isometric', 'front', 'top']): string[] {
  if (!polylines?.length) return []
  return views.map((v) => `data:image/png;base64,${wireframePng(polylines, v).toString('base64')}`)
}
