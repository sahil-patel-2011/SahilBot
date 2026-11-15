import { deflateRawSync } from 'node:zlib'

// A small ZIP writer (deflate, UTF-8 names) for exporting the vault, so no zip library is needed.

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

export function zipFiles(files: Array<{ name: string; data: Buffer; mtime?: Date }>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name.replace(/\\/g, '/').replace(/^\/+/, ''), 'utf8')
    const raw = f.data
    const packed = deflateRawSync(raw, { level: 6 })
    const useDeflate = packed.length < raw.length
    const body = useDeflate ? packed : raw
    const crc = crc32(raw)
    const { time, date } = dosTime(f.mtime ?? new Date())
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0x0800, 8)
    c.writeUInt16LE(useDeflate ? 8 : 0, 10)
    c.writeUInt16LE(time, 12)
    c.writeUInt16LE(date, 14)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(body.length, 20)
    c.writeUInt32LE(raw.length, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt16LE(0, 30)
    c.writeUInt16LE(0, 32)
    c.writeUInt16LE(0, 34)
    c.writeUInt16LE(0, 36)
    c.writeUInt32LE(0, 38)
    c.writeUInt32LE(offset, 42)
    central.push(c, name)
    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cd, end])
}
