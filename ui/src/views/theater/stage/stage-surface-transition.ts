// Owns only temporary surfaces. The displayed surface belongs to the renderer.
// Cancellation commits an already displayed target and discards an unready target.
export const createSurfaceTransitionController = <T>(dispose: (surface: T) => void) => {
  let generation = 0
  let pending: T | null = null
  let finish: (() => void) | null = null
  const cancel = () => {
    generation++
    finish?.()
    finish = null
    if (pending) dispose(pending)
    pending = null
  }
  return {
    cancel,
    get busy() { return pending !== null || finish !== null },
    begin(surface: T) {
      cancel()
      pending = surface
      return generation
    },
    ready(token: number, previous: T, commit: (surface: T) => void, animate: (previous: T, next: T, done: () => void) => () => void) {
      if (generation !== token || !pending) return false
      const next = pending
      pending = null
      commit(next)
      let stopped = false
      let stop: (() => void) | undefined
      const done = () => {
        if (stopped) return
        stopped = true
        stop?.()
        dispose(previous)
        finish = null
      }
      finish = done
      stop = animate(previous, next, done)
      if (stopped) stop()
      return true
    },
    failed(token: number) {
      if (generation === token) cancel()
    },
    isCurrent(token: number) { return generation === token },
  }
}
