import { handleRouteError } from "@/lib/http/route"
import { authenticateAgent, type AgentCaller } from "@/lib/agent/auth"

/** Wraps an /api/agent/* handler: authenticates first (nothing else runs on failure), then maps errors to {code,message,detail?}. */
export function agentRoute<C = unknown>(
  handler: (req: Request, caller: AgentCaller, ctx: C) => Promise<Response>,
): (req: Request, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    try {
      const caller = await authenticateAgent(req)
      return await handler(req, caller, ctx)
    } catch (e) {
      return handleRouteError(e)
    }
  }
}
