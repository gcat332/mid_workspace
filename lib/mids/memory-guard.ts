// Low-RAM guard before a MID is (re)started: one rule for the browser actions route and the AgentHub restart route.
import { readHostMemory } from "./status"

const GIB = 1024 ** 3
export const LOW_MEMORY_BYTES = GIB

/** Starting a JVM needs memory: start always, restart only when the MID is not already running/starting. */
export function startNeedsMemory(action: string, state: string): boolean {
  return action === "start" || (action === "restart" && state !== "running" && state !== "starting")
}

/**
 * null when there is enough free RAM, else the 409 `low_memory` response ({ code, message, availableBytes }).
 * `fix` is the Thai next step the caller can offer (the browser can confirm, AgentHub cannot).
 */
export async function lowMemoryResponse(fix: string): Promise<Response | null> {
  const { availableBytes } = await readHostMemory()
  if (availableBytes >= LOW_MEMORY_BYTES) return null
  const gb = (availableBytes / GIB).toFixed(1)
  return Response.json(
    { code: "low_memory", message: `RAM ว่างเหลือน้อย (${gb} GB) การ start อาจทำให้เครื่องช้าหรือ AgentHub ล่ม — ${fix}`, availableBytes },
    { status: 409 },
  )
}
