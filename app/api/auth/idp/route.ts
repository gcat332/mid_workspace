import { NextResponse } from "next/server"
import { idpService } from "@/lib/services/idp"

// Public: the login page reads this to decide whether to show the SSO button. No secrets.
export async function GET() {
  return NextResponse.json(await idpService.status())
}
