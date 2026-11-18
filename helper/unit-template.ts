import { MidError } from "../lib/mids/names"
import { MAX_HEAP_MB, MIN_HEAP_MB } from "../lib/helper/protocol"

// PROVISIONAL: confirm in spike (docs/spike-mid-linux.md)
export const EXEC_START_REL = "agent/bin/mid.sh console"

export function renderUnit({ heapMb, midRoot }: { name: string; heapMb: number; midRoot: string }): string {
  if (!Number.isInteger(heapMb) || heapMb < MIN_HEAP_MB || heapMb > MAX_HEAP_MB) {
    throw new MidError("invalid_request", 400, `heapMb must be an integer ${MIN_HEAP_MB}-${MAX_HEAP_MB}`)
  }
  // midRoot is derived from a validated name by the caller; refuse anything that could break out of a unit line.
  if (!/^\/[A-Za-z0-9/._-]+$/.test(midRoot)) throw new MidError("invalid_request", 400, "invalid midRoot")
  return `[Unit]
Description=MidHub MID Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=midsvc
Group=midhub
WorkingDirectory=${midRoot}/agent
# PROVISIONAL: confirm in spike (docs/spike-mid-linux.md)
ExecStart=${midRoot}/${EXEC_START_REL}
MemoryMax=${heapMb + 512}M
Restart=on-failure

[Install]
WantedBy=multi-user.target
`
}
