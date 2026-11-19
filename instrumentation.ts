// Next.js startup hook (once per server process). Node runtime only.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { initDbPragmas } = await import("@/lib/db/client")
  await initDbPragmas()
  // No admin seeding: users are AgentHub admins, created on their first sign-in (lib/auth/agenthub.ts).
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
  let kindsOk = true
  const kindStep = async (label: string, fn: () => unknown) => {
    try {
      await fn()
    } catch (err) {
      kindsOk = false
      console.error(`[boot] ${label} failed:`, err instanceof Error ? err.message : "unknown")
    }
  }
  // Surface a bad configuration (e.g. a non-loopback AGENTHUB_URL) in the boot log, not only on the first sign-in.
  await step("env", async () => (await import("@/lib/env")).loadEnv(process.env))
  // An AGENTHUB_SERVICE_USER missing from /etc/passwd would fail every sign-in: say so at boot too.
  await step("AGENTHUB_SERVICE_USER", async () => {
    const user = (await import("@/lib/env")).loadEnv(process.env).agenthubServiceUser
    if (user !== null) await (await import("@/lib/auth/listener-owner")).serviceUid(user)
  })
  await kindStep("registerInstallKinds", async () => (await import("@/lib/jobs/install")).registerInstallKinds())
  await kindStep("registerUninstallKinds", async () => (await import("@/lib/jobs/uninstall")).registerUninstallKinds())
  if (kindsOk) {
    await step("resumeJobs", async () => (await import("@/lib/jobs/engine")).resumeJobs())
    await step("reconcileOrphanedMids", async () => (await import("@/lib/jobs/reconcile")).reconcileOrphanedMids())
  } else {
    console.error("[boot] CRITICAL: job kinds not registered; skipping resumeJobs and reconcile, jobs will not run until restart")
  }
  await step("gcPackages", async () => (await import("@/lib/mids/packages")).gcPackages())
  await step("sweepArchives", async () => (await import("@/lib/jobs/uninstall")).sweepArchives())
  await step("sweepArchives schedule", () => {
    setInterval(
      () => void step("sweepArchives", async () => (await import("@/lib/jobs/uninstall")).sweepArchives()),
      24 * 3600_000,
    ).unref()
  })
}
