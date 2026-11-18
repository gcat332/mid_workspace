import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth/helpers"
import { recordAudit } from "@/lib/audit"
import { handleRouteError, jsonError, readJsonObject } from "@/lib/http/route"
import { idpService, missingForEnable, type IdpConfigData } from "@/lib/services/idp"

const SECRET_PLACEHOLDER = "••••"

// Admin-only. GET never returns the stored secret (a placeholder when one is set);
// PUT leaves it untouched when the placeholder or a blank value is submitted.
export async function GET() {
  try {
    await requireAdmin()
    const c = await idpService.get()
    return NextResponse.json({
      provider: c?.provider ?? "oidc",
      label: c?.label ?? "SSO",
      enabled: c?.enabled ?? false,
      issuer: c?.issuer ?? "",
      clientId: c?.clientId ?? "",
      clientSecret: c?.clientSecret ? SECRET_PLACEHOLDER : "",
      tenantId: c?.tenantId ?? "",
      redirectUri: c?.redirectUri ?? "",
      scopes: c?.scopes ?? "openid profile email",
    })
  } catch (e) {
    return handleRouteError(e)
  }
}

export async function PUT(req: Request) {
  try {
    const me = await requireAdmin()
    const b = ((await readJsonObject(req)) ?? {}) as Partial<Record<keyof IdpConfigData, unknown>>
    const data: Partial<IdpConfigData> = {
      provider: String(b.provider ?? "oidc"),
      label: String(b.label ?? "SSO"),
      enabled: !!b.enabled,
      // trim: a pasted space silently breaks discovery and redirect_uri matching.
      issuer: String(b.issuer ?? "").trim(),
      clientId: String(b.clientId ?? "").trim(),
      tenantId: String(b.tenantId ?? "").trim(),
      redirectUri: String(b.redirectUri ?? "").trim(),
      scopes: String(b.scopes ?? "openid profile email").trim(),
    }
    const secret = typeof b.clientSecret === "string" ? b.clientSecret.trim() : ""
    const secretChanged = Boolean(secret && secret !== SECRET_PLACEHOLDER)
    if (secretChanged) data.clientSecret = secret
    if (data.enabled) {
      const stored = await idpService.get()
      const missing = missingForEnable({ issuer: data.issuer!, clientId: data.clientId! }, secretChanged || Boolean(stored?.clientSecret))
      if (missing.length) {
        return jsonError("idp_incomplete", `เปิดใช้ SSO ไม่ได้: ยังไม่ได้กรอก ${missing.join(", ")} กรอกให้ครบแล้วบันทึกใหม่ (หรือปิดการใช้งานไว้ก่อน)`, 400)
      }
    }
    await idpService.upsert(data)
    // Never the secret itself.
    await recordAudit(me, "idp.update", undefined, {
      enabled: data.enabled, provider: data.provider, issuer: data.issuer, clientId: data.clientId, secretChanged,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleRouteError(e)
  }
}
