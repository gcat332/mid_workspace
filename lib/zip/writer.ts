import zlib from "node:zlib"
import { Readable, Transform, pipeline } from "node:stream"

export type ZipSource = { name: string; mtime: Date } & (
  | { dir: true }
  | { dir?: false; open: () => Promise<{ stream: AsyncIterable<Uint8Array>; close: () => Promise<void> } | null> }
)

const MAX32 = 0xffffffff
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107)
  const clamped = d.getFullYear() < 1980
  return {
    time: clamped ? 0 : (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: clamped ? (1 << 5) | 1 : ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

type Done = { name: Buffer; time: number; date: number; crc: number; csize: number; size: number; offset: number; dir: boolean }

function check(n: number) {
  if (n > MAX32) throw new Error("ZIP64 is not supported: archive too large")
}

async function* build(sources: AsyncIterable<ZipSource> | Iterable<ZipSource>): AsyncGenerator<Buffer> {
  const done: Done[] = []
  let offset = 0
  const emit = (b: Buffer) => { offset += b.length; return b }

  for await (const s of sources) {
    const name = Buffer.from(s.name, "utf8")
    if (name.length > 0xffff) throw new Error("zip entry name too long")
    const { time, date } = dosDateTime(s.mtime)
    const isDir = "dir" in s && s.dir === true
    let handle: { stream: AsyncIterable<Uint8Array>; close: () => Promise<void> } | null = null
    if (!isDir) {
      handle = await (s as Extract<ZipSource, { open: unknown }>).open()
      if (!handle) continue
    }
    try {
      check(offset)
      const entryOffset = offset
      yield emit(Buffer.concat([
        u32(0x04034b50), u16(20), u16(0x0808), u16(isDir ? 0 : 8), u16(time), u16(date),
        u32(0), u32(0), u32(0), u16(name.length), u16(0), name,
      ]))
      let crc = 0
      let size = 0
      let csize = 0
      if (handle) {
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            crc = zlib.crc32(chunk, crc)
            size += chunk.length
            cb(null, chunk)
          },
        })
        const deflate = zlib.createDeflateRaw()
        pipeline(Readable.from(handle.stream, { objectMode: false }), counter, deflate, () => {})
        for await (const out of deflate) {
          csize += out.length
          check(csize)
          yield emit(out as Buffer)
        }
        check(size)
        yield emit(Buffer.concat([u32(0x08074b50), u32(crc), u32(csize), u32(size)]))
      } else {
        yield emit(Buffer.concat([u32(0x08074b50), u32(0), u32(0), u32(0)]))
      }
      done.push({ name, time, date, crc, csize, size, offset: entryOffset, dir: isDir })
    } finally {
      if (handle) await handle.close()
    }
  }

  check(offset)
  const cdStart = offset
  for (const e of done) {
    yield emit(Buffer.concat([
      u32(0x02014b50), u16(0x031e), u16(20), u16(0x0808), u16(e.dir ? 0 : 8), u16(e.time), u16(e.date),
      u32(e.crc), u32(e.csize), u32(e.size), u16(e.name.length), u16(0), u16(0), u16(0), u16(0),
      u32(e.dir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0), u32(e.offset), e.name,
    ]))
  }
  const cdSize = offset - cdStart
  check(offset)
  if (done.length > 0xffff) throw new Error("ZIP64 is not supported: too many entries")
  yield emit(Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(done.length), u16(done.length), u32(cdSize), u32(cdStart), u16(0),
  ]))
}

/** Streams a valid ZIP of `sources` in order. `open` returning null skips that entry (vanished). */
export function zipStream(sources: AsyncIterable<ZipSource> | Iterable<ZipSource>): ReadableStream<Uint8Array> {
  const it = build(sources)
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const r = await it.next()
        if (r.done) controller.close()
        else controller.enqueue(r.value)
      },
      async cancel() {
        await it.return(undefined)
      },
    },
    { highWaterMark: 0 },
  )
}
