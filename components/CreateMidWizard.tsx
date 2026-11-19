"use client"

import { useMemo, useRef, useState } from "react"
import { ConfirmDialog } from "./ConfirmDialog"
import { Modal } from "./Modal"
import { ErrorNotice, readApiError, type ApiError } from "./ErrorNotice"
import { JobProgress } from "./JobProgress"
import { InstanceStep } from "./wizard/InstanceStep"
import { ReviewStep } from "./wizard/ReviewStep"
import { SettingsStep, type ExtraDraft } from "./wizard/SettingsStep"
import { apiFetch } from "@/lib/ui/api"
import { ghostBtnCls } from "@/lib/ui/classes"
import type { HostView, MidView } from "@/lib/ui/status-view"
import { DEFAULT_HEAP_MB, DEFAULT_LOG_FILES, canProceed, deriveNameCheck, effectiveBuildstamp, reviewChecks, type NameResult, type WizardState } from "@/lib/ui/wizard"

type Props = {
  isAdmin: boolean
  host: HostView | null
  mids: MidView[]
  /** job being followed (from ?job=); when set the wizard shows step 4 */
  jobId: string | null
  onJobChange: (id: string) => void
  onOpenMid: (name: string) => void
  onClose: () => void
  /** The create POST was accepted (host shows the MID as busy until its next poll confirms the job). */
  onStarted?: (name: string) => void
  userId: string
}

const STEPS = ["Instance", "Settings", "Review", "Install"] as const
const INITIAL: WizardState = {
  instance: null, pendingNew: false, buildstamp: "", name: "", nameCheck: "idle", snName: "",
  heapMb: String(DEFAULT_HEAP_MB), logFiles: String(DEFAULT_LOG_FILES), proxyOn: false, proxyHost: "", proxyPort: "",
}

export function CreateMidWizard({ isAdmin, host, mids, jobId, onJobChange, onOpenMid, onClose, onStarted, userId }: Props) {
  const [jobKind, setJobKind] = useState<string | null>(null)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [state, setState] = useState<WizardState>(INITIAL)
  const [extra, setExtra] = useState<ExtraDraft>({ cloneFrom: "", proxyUser: "", proxyPass: "", snTouched: false })
  const [nameResult, setNameResult] = useState<NameResult | null>(null)
  const [instanceLabel, setInstanceLabel] = useState("")
  const [confirmClose, setConfirmClose] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiError | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const patch = useMemo(() => (p: Partial<WizardState>) => setState((s) => ({ ...s, ...p })), [])
  const patchExtra = useMemo(() => (p: Partial<ExtraDraft>) => setExtra((s) => ({ ...s, ...p })), [])
  const checks = useMemo(() => reviewChecks(host), [host])
  const live: WizardState = { ...state, nameCheck: deriveNameCheck(state.name, nameResult) }
  const verdict = canProceed(step, live, checks)
  const running = jobId !== null

  const go = (s: 1 | 2 | 3) => { setErr(null); setStep(s); bodyRef.current?.scrollTo?.({ top: 0 }) }

  async function install() {
    if (!verdict.ok || busy || !state.instance) return
    setBusy(true); setErr(null)
    const body: Record<string, unknown> = {
      instanceId: state.instance.id,
      name: state.name,
      snName: state.snName,
      heapMb: Number(state.heapMb),
      logFiles: Number(state.logFiles),
      buildstamp: effectiveBuildstamp(live),
    }
    if (extra.cloneFrom) body.cloneFrom = extra.cloneFrom
    if (state.proxyOn) {
      body.proxy = {
        host: state.proxyHost.trim(), port: Number(state.proxyPort),
        ...(extra.proxyUser ? { user: extra.proxyUser } : {}), ...(extra.proxyPass ? { password: extra.proxyPass } : {}),
      }
    }
    try {
      const res = await apiFetch("/mids", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      if (!res.ok) { setErr(await readApiError(res)); return }
      const { jobId: id } = (await res.json()) as { jobId: string }
      onJobChange(id)
      onStarted?.(state.name)
    } catch {
      setErr({ message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่" })
    } finally {
      setBusy(false)
    }
  }

  // The instance label is only needed for the summary; read it from the list the step already loaded via the selection.
  const onInstanceChange = (p: Partial<WizardState>) => {
    patch(p)
    if (p.instance === null) setInstanceLabel("")
  }

  // Closing steps 1-3 with typed/selected input asks first; the progress step just closes (the job keeps running).
  const dirty = state.pendingNew || state.name !== "" || state.buildstamp !== "" || state.instance !== null || extra.cloneFrom !== "" || state.proxyOn
  const requestClose = () => { if (!running && dirty) setConfirmClose(true); else onClose() }

  const active = running ? 4 : step
  const nextLabel = step === 3 ? "Install" : "Next"

  return (
    <Modal labelledBy="wizard-title" onClose={requestClose} busy={busy} wide>
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 sm:px-5 dark:border-neutral-700">
        <h2 id="wizard-title" className="text-lg font-semibold text-gray-900 dark:text-neutral-100">{running ? (jobKind === "clone" ? "Clone MID" : "Install MID") : "New MID Server"}</h2>
        <button type="button" onClick={requestClose} disabled={busy} aria-label="Close" className="rounded-lg px-2 py-1 text-xl leading-none text-gray-600 hover:bg-gray-100 disabled:opacity-50">×</button>
      </div>

      <ol aria-label="Steps" className="flex items-center gap-1 border-b border-gray-200 px-4 py-3 sm:gap-2 sm:px-5 dark:border-neutral-700">
        {STEPS.map((label, i) => {
          const n = i + 1
          const cur = n === active
          const done = n < active
          return (
            <li key={label} aria-current={cur ? "step" : undefined} className="flex min-w-0 items-center gap-2">
              <span aria-hidden className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${cur ? "bg-blue-600 text-white" : done ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}`}>
                {done ? "✓" : n}
              </span>
              <span className={`${cur ? "" : "max-sm:sr-only"} truncate text-sm ${cur ? "font-semibold text-gray-900 dark:text-neutral-100" : "text-gray-600"}`}>
                <span className="sr-only">{`${n}. `}</span>{label}
                <span className="sr-only">{` (${cur ? "current" : done ? "done" : "pending"})`}</span>
              </span>
              {n < STEPS.length && <span aria-hidden className="mx-0.5 h-px w-3 bg-gray-300 sm:w-6" />}
            </li>
          )
        })}
      </ol>

      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
        {running ? (
          <JobProgress key={jobId} viewer={{ isAdmin, userId }} jobId={jobId} onJobChange={onJobChange} onOpenMid={onOpenMid} onClose={onClose}
            onStatus={(j) => {
              // This view is for installs only: a removal job (e.g. from a stale ?job= link) is shown by the panel/dialog instead.
              if (j.kind !== "install" && j.kind !== "clone") onClose()
              else setJobKind(j.kind)
            }} />
        ) : step === 1 ? (
          <InstanceStep isAdmin={isAdmin} state={state} onChange={onInstanceChange} onLabel={setInstanceLabel} />
        ) : step === 2 ? (
          <SettingsStep state={live} nameResult={nameResult} onNameResult={setNameResult} extra={extra} mids={mids} onChange={patch} onExtra={patchExtra} />
        ) : (
          <div className="space-y-4">
            <ReviewStep state={live} extra={extra} instanceLabel={instanceLabel} checks={checks} hostLoading={false} />
            {err && <ErrorNotice error={err} />}
          </div>
        )}
      </div>

      {!running && (
        <div className="border-t border-gray-200 px-4 py-3 sm:px-5 dark:border-neutral-700">
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={() => go((step - 1) as 1 | 2)} disabled={step === 1 || busy} className={ghostBtnCls}>Back</button>
            <button type="button" disabled={!verdict.ok || busy} aria-describedby={!verdict.ok && verdict.reason ? "wizard-reason" : undefined}
              onClick={() => (step === 3 ? void install() : go((step + 1) as 2 | 3))}
              className="btn-primary px-5 py-2 text-sm font-medium">
              {busy ? "Starting…" : nextLabel}
            </button>
          </div>
          {!verdict.ok && verdict.reason && <p id="wizard-reason" className="mt-2 text-right text-xs text-gray-600">{verdict.reason}</p>}
        </div>
      )}
      {confirmClose && (
        <ConfirmDialog title="Discard Changes?" confirmLabel="Discard" danger onConfirm={onClose} onCancel={() => setConfirmClose(false)}>
          ข้อมูลที่กรอกหรือเลือกไว้ในหน้านี้จะหายไป
        </ConfirmDialog>
      )}
    </Modal>
  )
}
