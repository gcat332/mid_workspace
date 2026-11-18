// Next.js startup hook (once per server process). Node runtime only.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { initDbPragmas } = await import("@/lib/db/client")
  await initDbPragmas()
  const { seedAdmin } = await import("@/lib/db/seed")
  try {
    await seedAdmin()
  } catch (err) {
    console.error("[seed] admin seed failed:", err instanceof Error ? err.message : "unknown")
  }
  try {
    const { normalizeInstanceRows } = await import("@/lib/instances/normalize-rows")
    await normalizeInstanceRows()
  } catch (err) {
    console.error("[instances] url normalisation failed:", err instanceof Error ? err.message : "unknown")
  }
}
