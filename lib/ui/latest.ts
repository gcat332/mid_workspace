/** Request-sequence guard: only the response of the most recently started request may be applied. */
export function createLatest() {
  let seq = 0
  return {
    next: (): number => ++seq,
    isCurrent: (token: number): boolean => token === seq,
  }
}
