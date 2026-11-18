// Import-free: shared by client components, the app and the root helper build.

/** quota_full text with the configured maximum (callers pass MIDHUB_MAX_RUNNING / host.maxRunning). */
export const quotaFullMessage = (maxRunning: number): string => `รันครบ ${maxRunning} ตัวแล้ว ให้หยุดตัวอื่นก่อน`
