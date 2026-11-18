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
  const step = async (label: string, fn: () => unknown | Promise<unknown>) => {
    try {
      await fn()
    } catch (err) {
      console.error(`[boot] ${label} failed:`, err instanceof Error ? err.message : "unknown")
    }
  }
  await step("registerInstallKinds", async () => (await import("@/lib/jobs/install")).registerInstallKinds())
  await step("registerUninstallKinds", async () => (await import("@/lib/jobs/uninstall")).registerUninstallKinds())
  await step("resumeJobs", async () => (await import("@/lib/jobs/engine")).resumeJobs())
  await step("gcPackages", async () => (await import("@/lib/mids/packages")).gcPackages())
  await step("sweepArchives", async () => (await import("@/lib/jobs/uninstall")).sweepArchives())
  await step("sweepArchives schedule", () => {
    setInterval(
      () => void step("sweepArchives", async () => (await import("@/lib/jobs/uninstall")).sweepArchives()),
      24 * 3600_000,
    ).unref()
  })
}
