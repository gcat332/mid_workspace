/** WAI-ARIA tabs keyboard model: index of the tab a key moves to, or null when the key is not a tab key. */
export function tabKeyTarget(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowRight": return (current + 1) % count
    case "ArrowLeft": return (current - 1 + count) % count
    case "Home": return 0
    case "End": return count - 1
    default: return null
  }
}
