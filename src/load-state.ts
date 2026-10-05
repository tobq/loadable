import { LoadError, loading, LoadingToken, type Loadable } from "./core.js"
import { useDelayedFlag } from "./delayed-flag.js"

/**
 * How a value slot should present itself, the one vocabulary every UI kit shares:
 * - `"loading"`: nothing to show yet; render the slot's skeleton in its real place.
 * - `"pending"`: a newer value is on its way; keep the previous one, dimmed, with the shimmer.
 * - `"stale"`: the latest load failed; keep the previous one, dimmed, next to a retry.
 * - `undefined`: show the value as it is (or the missing dash when there is none).
 *
 * @public
 */
export type LoadState = "loading" | "pending" | "stale"

/**
 * How long a reload may run before it is announced. Shorter waits keep the old value crisp, so a
 * fast answer never flickers the screen.
 *
 * @public
 */
export const PENDING_GRACE_MS = 150

/**
 * The presentation state of a loadable, with no grace applied. Pure; {@link useLoadState} is the
 * hook most views want.
 *
 * @param pendingVisible - Whether a reload has outlasted its grace (default true).
 *
 * @public
 */
export function loadStateOf(loadable: Loadable<unknown>, pendingVisible = true): LoadState | undefined {
    if (loadable === loading) return "loading"
    if (loadable instanceof LoadingToken) {
        if (!loadable.hasPrevious) return "loading"
        return pendingVisible ? "pending" : undefined
    }
    if (loadable instanceof LoadError) return loadable.hasPrevious ? "stale" : undefined
    return undefined
}

/**
 * The presentation state of a loadable, holding `"pending"` back for a short grace so a fast reload
 * never flickers. Pair it with {@link latest} for the value to show:
 *
 * @example
 * ```tsx
 * const [rows, reload] = useLoadableQuery(fetchRows, [filter], { debounceMs: 180 })
 * <Table rows={latest(rows)} state={useLoadState(rows)} />
 * {loadFailed(rows) && <LoadFailed what="rows" error={rows} onRetry={reload} />}
 * ```
 *
 * @public
 */
export function useLoadState(
    loadable: Loadable<unknown>,
    opts?: { graceMs?: number }
): LoadState | undefined {
    const reloading = loadable instanceof LoadingToken && loadable.hasPrevious
    const pendingVisible = useDelayedFlag(reloading, opts?.graceMs ?? PENDING_GRACE_MS, {
        sinceMs: reloading ? (loadable as LoadingToken).startTime : undefined,
    })
    return loadStateOf(loadable, pendingVisible)
}
