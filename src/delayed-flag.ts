import { useEffect, useState } from "react"

/** Has a wait that started at `sinceMs` already run past `ms`? Pure, so the initial state below can
 *  be computed WITHOUT an effect (see the SSR note on the hook). */
function alreadyElapsed(ms: number, sinceMs?: number, now: number = Date.now()): boolean {
    return sinceMs != null && now - sinceMs >= ms
}

/**
 * `true` only once `active` has held for `ms`: a GRACE, not a debounce.
 *
 * @remarks
 * It exists so a surface that explains a WAIT never flashes during a wait too short to notice: a
 * reload that answers in 80 ms should not dim the screen and undim it again.
 *
 * `sinceMs` is what makes this a grace on the WAIT rather than on the mount. A wait that has already
 * run for ten minutes is not a wait too short to notice, but a mount-relative timer cannot tell the
 * two apart, so opening that view would stare back blankly for the whole grace before admitting
 * anything was happening. Passing the moment the wait actually began (for a load, the
 * `LoadingToken`'s `startTime`) makes an old wait paint at once and a brand-new one hold its tongue.
 *
 * It also removes a test trap. `renderToStaticMarkup` never runs effects, so a hook whose truth lives
 * only in a `setTimeout` is false forever under SSR; deriving the initial state from `sinceMs` puts
 * the elapsed case in reach of a plain render.
 *
 * Falls back to false IMMEDIATELY when `active` goes false: the delay is deliberately one-sided. A
 * symmetric hold would leave the indicator up explaining a wait that has already ended, which is the
 * worse error: an explanation that is late is quiet, an explanation that is wrong is a bug report.
 *
 * `resetKey` restarts the timer without unmounting: when the thing being waited ON changes identity,
 * the new wait has genuinely just begun, and inheriting the previous one's elapsed grace would let a
 * brand-new state appear instantly. Leave it undefined when any continuous `active` run is one wait.
 *
 * @public
 */
export function useDelayedFlag(
    active: boolean,
    ms: number,
    opts?: { sinceMs?: number; resetKey?: string }
): boolean {
    const sinceMs = opts?.sinceMs
    const resetKey = opts?.resetKey
    const [on, setOn] = useState(() => active && alreadyElapsed(ms, sinceMs))
    useEffect(() => {
        if (!active) {
            setOn(false)
            return
        }
        // Remaining, not the full `ms`: a wait already six seconds old owes nothing further. Computed
        // here rather than reusing the render-time value so a re-run after a long background tab does
        // not re-arm a timer that should already have fired.
        const remaining = sinceMs != null ? Math.max(0, ms - (Date.now() - sinceMs)) : ms
        if (remaining <= 0) {
            setOn(true)
            return
        }
        setOn(false)
        const t = setTimeout(() => setOn(true), remaining)
        return () => clearTimeout(t)
    }, [active, ms, sinceMs, resetKey])
    return on
}
