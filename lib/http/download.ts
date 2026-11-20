import { Readable } from "node:stream"
import type { FileHandle } from "node:fs/promises"

export const contentDisposition = (filename: string): string =>
  `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`

/** Streams exactly `size` bytes from an already verified handle (later growth is not sent); the stream closes the handle. */
export async function downloadResponse(d: { handle: FileHandle; size: number; filename: string }): Promise<Response> {
  const { handle, size, filename } = d
  let body: ReadableStream | null = null
  if (size === 0) await handle.close()
  else body = Readable.toWeb(handle.createReadStream({ start: 0, end: size - 1, autoClose: true })) as ReadableStream
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(size),
      "Content-Disposition": contentDisposition(filename),
      "X-Content-Type-Options": "nosniff",
    },
  })
}
