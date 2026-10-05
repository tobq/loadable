// The 2.0 hooks (useLoadable, useThen, useAllThen, useLoadableWithCleanup), now one core. Their
// return union and timing are unchanged; see test/compat.test.tsx for what is pinned.
import { DependencyList, useCallback, useEffect, useRef, useState } from "react"
import { parseCacheOption, readCache, writeCache, type CacheOption, type ParsedCache } from "./cache.js"
import {
    all,
    beginRequest,
    currentTimestamp,
    type Fetcher,
    forgetRequest,
    hasLoaded,
    invoke,
    isLoadingValue,
    LoadError,
    loading,
    type Loadable,
    type Loaded,
    map,
    nextRequestId,
    reportError,
    settleRequest,
    type TimeStamp,
    toLoadError,
} from "./core.js"

/**
 * Provides a stable function that, when called, aborts the previous `AbortController` (if any) and
 * returns a fresh `AbortSignal`.
 *
 * @public
 */
export function useAbort(): () => AbortSignal {
    const abortControllerRef = useRef<AbortController | null>(null)
    return useCallback(() => {
        abortControllerRef.current?.abort()
        abortControllerRef.current = new AbortController()
        return abortControllerRef.current.signal
    }, [])
}

/**
 * State with an ordering stamp: an update stamped older than the current state is ignored.
 *
 * @remarks
 * Like `useState`, a function passed to the setter is an updater. To store a function as the
 * value, pass `() => fn`.
 *
 * @returns `[value, setValue, loadStart]`.
 *
 * @public
 */
export function useLatestState<T>(
    initial: T
): [T, (value: T | ((current: T) => T), loadStart?: TimeStamp) => void, TimeStamp] {
    const [state, setState] = useState<{ value: T; loadStart: TimeStamp }>({
        value: initial,
        loadStart: 0,
    })

    const updateValue = useCallback(
        (newValue: T | ((current: T) => T), loadStart: TimeStamp = currentTimestamp()) => {
            setState(current => {
                if (current.loadStart > loadStart) return current
                const nextValue =
                    typeof newValue === "function" ? (newValue as (c: T) => T)(current.value) : newValue
                return { value: nextValue, loadStart }
            })
        },
        []
    )

    return [state.value, updateValue, state.loadStart]
}

/**
 * The options object for `useLoadable`.
 *
 * @public
 */
export interface UseLoadableOptions<T = any> {
    /**
     * A prefetched loadable value, used instead of calling the fetcher.
     */
    prefetched?: Loadable<T>
    /**
     * Called with the raw error when a load fails (never for an aborted request).
     */
    onError?: (error: unknown) => void
    /**
     * Once a value has loaded, keep showing it (with no signal) while the next one loads instead of
     * reverting to `loading`. For a reload the UI should SEE, use `useLoadableQuery`.
     */
    hideReload?: boolean
    /**
     * @deprecated Caching will be removed in 3.0 (it never revalidates and its keys are global).
     */
    cache?: string | CacheOption
}

interface CoreOptions {
    onError?: (error: unknown) => void
    hideReload: boolean
    cache: ParsedCache
}

function coreOptions(param?: ((e: unknown) => void) | UseLoadableOptions<any>): CoreOptions {
    if (typeof param === "function") {
        return { onError: param, hideReload: false, cache: parseCacheOption() }
    }
    return {
        onError: param?.onError,
        hideReload: !!param?.hideReload,
        cache: parseCacheOption(param?.cache),
    }
}

/**
 * The one effect behind every 2.0 hook.
 *
 * Results are applied only from the request that is still current: a superseded or unmounted
 * request is aborted and its outcome dropped, so an abort can never surface as a `LoadError`.
 * Requests are ordered by a counter, not a timestamp.
 */
function useLoadableCore<W, R>(
    waitable: W,
    readyCondition: (loaded: W) => boolean,
    fetcher: (loaded: W, abort: AbortSignal) => Promise<R>,
    dependencies: DependencyList,
    options: CoreOptions
): [Loadable<R>, () => void] {
    const [value, setValue] = useLatestState<Loadable<R>>(loading)
    const controllerRef = useRef<AbortController | null>(null)
    const ready = readyCondition(waitable)
    const { onError, hideReload, cache } = options

    useEffect(() => {
        const id = nextRequestId()
        if (!hideReload || !hasLoaded(value)) {
            setValue(loading, id)
        }
        if (!ready) return

        const controller = new AbortController()
        controllerRef.current = controller
        const { signal } = controller
        beginRequest(id)

        invoke(async () => {
            if (cache.key) {
                const cached = await readCache<R>(cache.key, cache.store)
                if (signal.aborted) return undefined as R
                if (cached !== undefined) setValue(() => cached, id)
            }
            return fetcher(waitable, signal)
        })
            .then(
                result => {
                    if (signal.aborted) return
                    if (cache.key) void writeCache(cache.key, result, cache.store)
                    setValue(() => result, id)
                },
                error => {
                    if (signal.aborted) return
                    reportError(onError, error)
                    setValue(() => toLoadError(error), id)
                }
            )
            .finally(() => settleRequest(id))

        return () => {
            controller.abort()
            forgetRequest(id)
        }
    }, [...dependencies, ready, hideReload])

    const cancel = useCallback(() => controllerRef.current?.abort(), [])
    return [value, cancel]
}

/** Wraps a plain fetcher with the 2.0 `prefetched` and `cache` behaviour. */
function simpleFetcher<T>(fetcher: Fetcher<T>, options?: UseLoadableOptions<T>) {
    const cache = parseCacheOption(options?.cache)
    return async (_ignored: unknown, signal: AbortSignal): Promise<T> => {
        if (cache.key) {
            const cached = await readCache<T>(cache.key, cache.store)
            if (cached !== undefined) return cached
        }
        const prefetched = options?.prefetched
        if (prefetched !== undefined && !isLoadingValue(prefetched)) {
            if (prefetched instanceof LoadError) throw prefetched
            if (cache.key) await writeCache(cache.key, prefetched, cache.store)
            return prefetched as T
        }
        const data = await fetcher(signal)
        if (cache.key) await writeCache(cache.key, data, cache.store)
        return data
    }
}

const alwaysReady = () => true

type AnyFetcherForm<T, W, R> = {
    fetcherOrWaitable: Fetcher<T> | W
    depsOrReadyCondition: DependencyList | ((loaded: W) => boolean)
    optionsOrFetcher?: UseLoadableOptions<T> | ((loaded: W, abort: AbortSignal) => Promise<R>)
    dependencies: DependencyList
    lastParam?: ((e: unknown) => void) | UseLoadableOptions<R>
}

function useEitherForm<T, W, R>(form: AnyFetcherForm<T, W, R>): [Loadable<T> | Loadable<R>, () => void] {
    if (typeof form.depsOrReadyCondition === "function") {
        return useLoadableCore(
            form.fetcherOrWaitable as W,
            form.depsOrReadyCondition as (loaded: W) => boolean,
            form.optionsOrFetcher as (loaded: W, abort: AbortSignal) => Promise<R>,
            form.dependencies,
            coreOptions(form.lastParam)
        )
    }
    const options = form.optionsOrFetcher as UseLoadableOptions<T> | undefined
    return useLoadableCore<unknown, T>(
        loading,
        alwaysReady,
        simpleFetcher(form.fetcherOrWaitable as Fetcher<T>, options),
        form.depsOrReadyCondition as DependencyList,
        { onError: options?.onError, hideReload: !!options?.hideReload, cache: parseCacheOption() }
    )
}

/**
 * Overload: `useLoadable(waitable, readyCondition, fetcher, dependencies, optionsOrOnError?)`
 */
export function useLoadable<W, R>(
    waitable: W,
    readyCondition: (loaded: W) => boolean,
    fetcher: (loaded: W, abort: AbortSignal) => Promise<R>,
    dependencies: DependencyList,
    optionsOrOnError?: ((e: unknown) => void) | UseLoadableOptions<R>
): Loadable<R>

/**
 * Overload: `useLoadable(fetcher, deps, options?)`
 */
export function useLoadable<T>(
    fetcher: Fetcher<T>,
    deps: DependencyList,
    options?: UseLoadableOptions<T>
): Loadable<T>

/**
 * Returns a `Loadable<T>` by calling an async fetcher whenever `deps` change.
 *
 * @remarks
 * The value is `loading` until the fetch settles (or, with `hideReload`, the previous value),
 * then the data or a `LoadError`. The waitable form only fetches once `readyCondition(waitable)`
 * holds.
 *
 * For a reload the UI should be able to SHOW (the previous value carried in the loading marker),
 * debouncing, manual reload or background refresh, use {@link useLoadableQuery}.
 *
 * @public
 */
export function useLoadable<T, W, R>(
    fetcherOrWaitable: Fetcher<T> | W,
    depsOrReadyCondition: DependencyList | ((loaded: W) => boolean),
    optionsOrFetcher?: UseLoadableOptions<T> | ((loaded: W, abort: AbortSignal) => Promise<R>),
    dependencies: DependencyList = [],
    lastParam?: ((e: unknown) => void) | UseLoadableOptions<R>
): Loadable<T> | Loadable<R> {
    return useEitherForm({
        fetcherOrWaitable,
        depsOrReadyCondition,
        optionsOrFetcher,
        dependencies,
        lastParam,
    })[0]
}

/**
 * Waits for a `loadable` to load, then calls another async `fetcher` with its value.
 *
 * @remarks
 * While `loadable` is loading or has failed, this returns `loading`.
 *
 * @example
 * ```ts
 * const user = useLoadable(() => fetchUser(userId), [userId])
 * const posts = useThen(user, (u) => fetchPostsForUser(u.id))
 * ```
 *
 * @public
 */
export function useThen<T, R>(
    loadable: Loadable<T>,
    fetcher: (loaded: T, abort: AbortSignal) => Promise<R>,
    dependencies: DependencyList = [hasLoaded(loadable)],
    options?: UseLoadableOptions<R>
): Loadable<R> {
    return useLoadable(
        loadable,
        l => hasLoaded(l),
        async (val, abort) => map(val, v => fetcher(v, abort)),
        dependencies,
        options
    ) as Loadable<R>
}

/** @internal */
type LoadableParameters<T extends Loadable<any>[]> = {
    [K in keyof T]: Loaded<T[K]>
}

/**
 * Waits for several loadables to load, then calls a `fetcher` with all their values.
 *
 * @example
 * ```ts
 * const combined = useAllThen([user, stats], (u, s, signal) => fetchDashboard(u, s, signal), [])
 * ```
 *
 * @public
 */
export function useAllThen<const T extends Loadable<any>[], R>(
    loadables: [...T],
    fetcher: (...args: [...LoadableParameters<T>, AbortSignal]) => Promise<R>,
    dependencies: DependencyList = loadables,
    options?: UseLoadableOptions<R>
): Loadable<R> {
    const combined = all(...loadables)
    return useThen(
        combined,
        (vals, signal) => fetcher(...(vals as LoadableParameters<T>), signal),
        dependencies,
        options
    )
}

/**
 * Overload: `useLoadableWithCleanup(waitable, readyCondition, fetcher, deps, optionsOrOnError?)`.
 */
export function useLoadableWithCleanup<W, R>(
    waitable: W,
    readyCondition: (loaded: W) => boolean,
    fetcher: (loaded: W, abort: AbortSignal) => Promise<R>,
    dependencies: DependencyList,
    optionsOrOnError?: ((e: unknown) => void) | UseLoadableOptions<R>
): [Loadable<R>, () => void]

/**
 * Overload: `useLoadableWithCleanup(fetcher, deps, options?)`.
 */
export function useLoadableWithCleanup<T>(
    fetcher: Fetcher<T>,
    deps: DependencyList,
    options?: UseLoadableOptions<T>
): [Loadable<T>, () => void]

/**
 * `useLoadable` plus a function that aborts the request in flight.
 *
 * @returns `[Loadable<T>, abortInFlight]`.
 *
 * @public
 */
export function useLoadableWithCleanup<T, W, R>(
    fetcherOrWaitable: Fetcher<T> | W,
    depsOrReadyCondition: DependencyList | ((loaded: W) => boolean),
    optionsOrFetcher?: UseLoadableOptions<T> | ((loaded: W, abort: AbortSignal) => Promise<R>),
    dependencies: DependencyList = [],
    lastParam?: ((e: unknown) => void) | UseLoadableOptions<R>
): [Loadable<T> | Loadable<R>, () => void] {
    return useEitherForm({
        fetcherOrWaitable,
        depsOrReadyCondition,
        optionsOrFetcher,
        dependencies,
        lastParam,
    })
}
