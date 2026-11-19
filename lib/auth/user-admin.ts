// Shared by the admin user routes. Next.js route files may only export handlers, so this lives here.
// Never select passwordHash: it must not leave the server. The list is read-only apart from lock/unlock.
export const USER_SELECT = { id: true, email: true, lockedAt: true, lastLoginAt: true } as const
