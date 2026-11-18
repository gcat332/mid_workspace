// Shared by the admin user routes. Next.js route files may only export handlers, so these live here.
// Never select passwordHash: it must not leave the server.
export const USER_SELECT = { id: true, email: true, role: true, lockedAt: true, lastLoginAt: true } as const
export const PASSWORD_MIN_ERROR = "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร"
