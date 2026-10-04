/**
 * Double-confirm arm guard (docs/keybindings.md). Two destructive actions need
 * a second press within a short window while work is in flight: closing a
 * STREAMING tab (Ctrl+W / the tab `×`) and reverting a user message mid-work.
 * Both used a hand-rolled `armedId` + `setTimeout` pair in App.tsx; this class
 * owns that state with an injectable clock, mirroring PrefixMachine
 * (src/ui/chat/prefix.ts).
 *
 * The first call arms the target and the CALLER shows its own confirmation
 * toast; a second call for the SAME id while armed confirms (clear + proceed).
 * The window auto-disarms after `windowMs`. Pure state — no UI/opentui imports.
 */

export interface ArmGuardOptions {
  /** How long an arm stays valid before it auto-disarms (ms). */
  windowMs: number
  /** Clock seams (tests): schedule captures the callback, unschedule cancels. */
  schedule?: (fn: () => void, ms: number) => unknown
  unschedule?: (handle: unknown) => void
}

export class ArmGuard {
  private armedId: number | null = null
  private timer: unknown = null

  private readonly windowMs: number
  private readonly schedule: (fn: () => void, ms: number) => unknown
  private readonly unschedule: (handle: unknown) => void

  constructor(opts: ArmGuardOptions) {
    this.windowMs = opts.windowMs
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        setTimeout(fn, ms)
      })
    this.unschedule =
      opts.unschedule ??
      ((h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>)
      })
  }

  /** Is `id` the currently armed target? */
  isArmed(id: number): boolean {
    return this.armedId === id
  }

  /** Arm `id` (replacing any previous target/timer) and auto-disarm after the
   * window. The caller shows the confirmation prompt for the first press. */
  arm(id: number): void {
    this.cancelTimer()
    this.armedId = id
    this.timer = this.schedule(() => {
      this.timer = null
      this.armedId = null
    }, this.windowMs)
  }

  /** Disarm and cancel any pending window (a confirming press, teardown). */
  clear(): void {
    this.cancelTimer()
    this.armedId = null
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.unschedule(this.timer)
      this.timer = null
    }
  }
}
