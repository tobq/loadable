import { DependencyList, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
    beginRequest,
    currentTimestamp,
    type Fetcher,
    forgetRequest,
    invoke,
    isLoadingValue,
    LoadError,
    loading,
    LoadingToken,
    type Loadable,
    nextRequestId,
    reportError,
    sameDeps,
    settleRequest,
    toLoadError,
} from "./core.js"

/**
 * Options for {@link useLoadableQuery}.
 *
 * @public
 */
export interface UseLoadableQueryOptions<T> {
    /**
     * Wait this long after `deps` change before fetching, so a burst of changes (typing, dragging a
     * slider) costs one request. The previous value is still returned, as a pending `LoadingToken`,
     * from the very render the deps changed in. The first load and `reload()` are never debounced.
     */
    debounceMs?: number
    /**
     * Refresh silently every `refreshMs` while the page is visible. A refresh keeps returning the
     * current value (no pending state). Paused while the page is hidden; on return, a refresh that
     * fell due runs straight away. One failed refresh is ignored; two in a row turn the result into
     * a `LoadError` carrying the last good value. Never overlaps a request already in flight.
     */
    refreshMs?: number
    /**
     * Data already in hand for the FIRST deps key, e.g. a request the app started before React
     * mounted. A value or `LoadError` is shown with no request; a promise is used instead of the
     * first fetch (and survives StrictMode's double effect). Ignored once the deps change.
     */
    prefetched?: Loadable<T> | PromiseLike<T>
    /**
     * Called with the raw error whenever the result becomes a `LoadError`. Never called for an
     * aborted request or for a background miss that is not surfaced.
     */
    onError?: (error: unknown) => void
    /**
     * When false, no request is started (and one in flight is abandoned); the result keeps
     * whatever it holds. Flipping it to true loads the current deps. Use it to hold a first load
     * until its inputs are settled, e.g. until a saved view has been restored, so a page never
     * loads its defaults only to load again. Defaults to true.
     */
    enabled?: boolean
}

/**
 * Consecutive failed background refreshes before the failure is shown. One miss is a blip (a
 * redeploy, a dropped connection); two is a pattern worth telling the user about.
 *
 * @public
 */
export const BACKGROUND_MISSES_BEFORE_FAILURE = 2

interface QueryState<T> {
    /** The deps the current result belongs to (or is loading for). */
    deps: DependencyList
    /** Bumped by `reload()`. */
    nonce: number
    result: Loadable<T>
    /** The last good value, carried as `previous` by pending and failed markers. */
    good: { value: T } | undefined
}

interface Latest<T> {
    fetcher: Fetcher<T>
    onError?: (error: unknown) => void
    deps: DependencyList
}

interface Request {
    id: number
    controller: AbortController
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
    return value != null && typeof (value as PromiseLike<T>).then === "function"
}

function initialState<T>(deps: DependencyList, prefetched: UseLoadableQueryOptions<T>["prefetched"]): QueryState<T> {
    if (prefetched === undefined || isPromiseLike<T>(prefetched) || isLoadingValue(prefetched)) {
        return { deps, nonce: 0, result: loading, good: undefined }
    }
    if (prefetched instanceof LoadError) {
        const good = prefetched.hasPrevious ? { value: prefetched.previous as T } : undefined
        return { deps, nonce: 0, result: prefetched as LoadError<T>, good }
    }
    return { deps, nonce: 0, result: prefetched as T, good: { value: prefetched as T } }
}

/** The result while a new load runs: the previous value when there is one, else bare `loading`.
 *  A load that is already pending keeps its token, so the wait (and its grace) is measured from
 *  when it first began, not from the latest keystroke. */
function pendingFrom<T>(state: QueryState<T>): Loadable<T> {
    if (state.result instanceof LoadingToken && state.result.hasPrevious) return state.result
    if (!state.good) return loading
    return new LoadingToken<T>(currentTimestamp(), { previous: state.good.value })
}

/** Owns the requests and timers of one `useLoadableQuery`, outside React's render cycle. */
class QueryRunner<T> {
    private inflight: Request | null = null
    private misses = 0
    private refreshTimer: ReturnType<typeof setTimeout> | undefined
    private dueOnReturn = false
    /** A debounced foreground load is waiting to start. */
    scheduled = false
    refreshMs = 0
    /** False while the caller holds loads back (`enabled: false`): refreshes do not fire. */
    enabled = true

    constructor(
        private readonly setState: (update: (s: QueryState<T>) => QueryState<T>) => void,
        private readonly latest: { current: Latest<T> }
    ) {}

    /** Starts a load for the current deps. A foreground load supersedes anything in flight; a
     *  background one keeps the current result until it settles. Returns its cancel. */
    run(background: boolean, source?: PromiseLike<T>): () => void {
        this.inflight?.controller.abort()
        const request: Request = { id: nextRequestId(), controller: new AbortController() }
        const { signal } = request.controller
        const deps = this.latest.current.deps
        this.inflight = request
        if (!background) this.misses = 0
        beginRequest(request.id)

        const current = () => this.inflight === request && !signal.aborted
        // Belt and braces: a result also only lands on the deps it was requested for, in case a
        // concurrent render moved the deps before this request's cleanup ran.
        const apply = (update: (s: QueryState<T>) => QueryState<T>) =>
            this.setState(s => (sameDeps(s.deps, deps) ? update(s) : s))

        invoke(() => source ?? this.latest.current.fetcher(signal))
            .then(
                value => {
                    if (!current()) return
                    this.misses = 0
                    apply(s => ({ ...s, result: value, good: { value } }))
                },
                error => {
                    if (!current()) return
                    if (background && ++this.misses < BACKGROUND_MISSES_BEFORE_FAILURE) return
                    reportError(this.latest.current.onError, error)
                    apply(s => ({ ...s, result: toLoadError(error, s.good) }))
                }
            )
            .finally(() => {
                settleRequest(request.id)
                if (this.inflight !== request) return
                this.inflight = null
                if (!signal.aborted) this.scheduleRefresh()
            })

        return () => {
            request.controller.abort()
            forgetRequest(request.id)
            if (this.inflight === request) this.inflight = null
        }
    }

    scheduleRefresh(): void {
        clearTimeout(this.refreshTimer)
        this.refreshTimer = undefined
        if (!(this.refreshMs > 0)) return
        this.refreshTimer = setTimeout(() => this.tick(), this.refreshMs)
    }

    /** A refresh fell due. Anything already loading reschedules the next one when it settles. */
    private tick(): void {
        this.refreshTimer = undefined
        if (this.inflight || this.scheduled || !this.enabled) return
        if (typeof document !== "undefined" && document.hidden) {
            this.dueOnReturn = true
            return
        }
        this.run(true)
    }

    onVisibilityChange(): void {
        if (typeof document === "undefined" || document.hidden || !this.dueOnReturn) return
        this.dueOnReturn = false
        this.tick()
    }

    stopRefreshing(): void {
        clearTimeout(this.refreshTimer)
        this.refreshTimer = undefined
        this.dueOnReturn = false
    }

    /** Unmount: abandon whatever is in flight. The runner stays usable (StrictMode remounts). */
    stop(): void {
        this.stopRefreshing()
        this.inflight?.controller.abort()
        this.inflight = null
        this.scheduled = false
    }
}

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

/**
 * Loads data for `deps`, keeping the previous value visible while the next one loads.
 *
 * @remarks
 * Returns `[result, reload]`. `result` is the ordinary `Loadable<T>` union:
 * - `loading` until there is anything to show;
 * - `T` once loaded;
 * - a `LoadingToken` carrying `previous` while a newer value loads (deps changed, or `reload()`),
 *   from the very render the deps changed in;
 * - a `LoadError` carrying `previous` when a load fails after a good value was shown.
 *
 * Read the value to show with {@link latest} and the presentation state with
 * {@link useLoadState}. Superseded requests are aborted and never reported as failures.
 *
 * @example
 * ```tsx
 * const [usage, reload] = useLoadableQuery(signal => fetchUsage(range, signal), [range], {
 *   debounceMs: 180,
 *   refreshMs: 60_000,
 * })
 * const state = useLoadState(usage)
 * <Stat value={latest(usage)?.total} state={state} />
 * {loadFailed(usage) && <LoadFailed what="usage" error={usage} onRetry={reload} />}
 * ```
 *
 * @public
 */
export function useLoadableQuery<T>(
    fetcher: Fetcher<T>,
    deps: DependencyList,
    options: UseLoadableQueryOptions<T> = {}
): [Loadable<T>, () => void] {
    const { debounceMs = 0, refreshMs = 0, onError, enabled = true } = options
    const [state, setState] = useState(() => initialState<T>(deps, options.prefetched))
    const [firstPrefetched] = useState(() => options.prefetched)

    // Deps are compared during render, as React compares effect deps, so the render in which they
    // change already returns the pending marker instead of one frame of the old value as current.
    let current = state
    if (!sameDeps(state.deps, deps)) {
        current = { ...state, deps, result: pendingFrom(state) }
        setState(current)
    }

    const latest = useRef<Latest<T>>({ fetcher, onError, deps })
    useIsomorphicLayoutEffect(() => {
        latest.current = { fetcher, onError, deps }
    })
    const [runner] = useState(() => new QueryRunner<T>(setState, latest))

    const ranDeps = useRef<DependencyList | undefined>(undefined)
    const onFirstKey = useRef(true)

    useEffect(() => {
        runner.enabled = enabled
        if (!enabled) return
        const depsChanged = ranDeps.current !== undefined && !sameDeps(ranDeps.current, deps)
        ranDeps.current = deps
        if (depsChanged || current.nonce !== 0) onFirstKey.current = false

        let source: PromiseLike<T> | undefined
        if (onFirstKey.current && firstPrefetched !== undefined) {
            if (isPromiseLike<T>(firstPrefetched)) source = firstPrefetched
            else if (!isLoadingValue(firstPrefetched)) return // already settled: nothing to fetch
        }

        let cancel: (() => void) | undefined
        const delay = depsChanged ? debounceMs : 0
        if (delay > 0) {
            runner.scheduled = true
            const timer = setTimeout(() => {
                runner.scheduled = false
                cancel = runner.run(false, source)
            }, delay)
            return () => {
                clearTimeout(timer)
                runner.scheduled = false
                cancel?.()
            }
        }
        cancel = runner.run(false, source)
        return () => cancel?.()
    }, [...deps, current.nonce, enabled])

    useEffect(() => {
        runner.refreshMs = refreshMs
        if (!(refreshMs > 0)) {
            runner.stopRefreshing()
            return
        }
        runner.scheduleRefresh()
        const onVisibility = () => runner.onVisibilityChange()
        document.addEventListener("visibilitychange", onVisibility)
        return () => {
            document.removeEventListener("visibilitychange", onVisibility)
            runner.stopRefreshing()
        }
    }, [refreshMs, runner])

    useEffect(() => () => runner.stop(), [runner])

    const reload = useCallback(() => {
        setState(s => ({ ...s, nonce: s.nonce + 1, result: pendingFrom(s) }))
    }, [])

    return [current.result, reload]
}
