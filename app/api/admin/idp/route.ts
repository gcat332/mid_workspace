import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth/helpers"
import { idpService, type IdpConfigData } from "@/lib/services/idp"

const SECRET_PLACEHOLDER = "••••"

// Admin-only. GET never returns the stored secret (a placeholder when one is set);
// PUT leaves it untouched when the placeholder or a blank value is submitted.
export async function GET() {
  try { await requireAdmin() } catch (res) { return res as Response }
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
}

export async function PUT(req: Request) {
  try { await requireAdmin() } catch (res) { return res as Response }
  const b = (await req.json().catch(() => ({}))) as Partial<IdpConfigData>
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
  if (secret && secret !== SECRET_PLACEHOLDER) data.clientSecret = secret
  await idpService.upsert(data)
  return NextResponse.json({ ok: true })
}
