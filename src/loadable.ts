import {
    DependencyList,
    Dispatch,
    SetStateAction,
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState
} from "react"
import { currentTimestamp, TimeStamp, useAbort } from "./utils"

//
// NEW: A class-based loading token, plus a helper to create it.
//
export class LoadingToken {
    constructor(
        /** When this token was created. You can store other fields here if needed. */
        public readonly startTime: TimeStamp = currentTimestamp()
    ) {}
}

/**
 * Create a fresh LoadingToken.
 *
 * Even if you just do `new LoadingToken()`, having this helper
 * makes it easier to tweak or extend the creation logic later.
 */
export function newLoadingToken(): LoadingToken {
    return new LoadingToken()
}

//
// We'll keep the old symbol-based approach as well.
//
export const loading: unique symbol = Symbol("loading")

/**
 * A union type that can be either the old symbol or the new class-based token.
 */
export type Loading = typeof loading | LoadingToken

/**
 * Simple helper to check if something is in a "loading" state,
 * i.e. either the `loading` symbol or an instance of `LoadingToken`.
 */
export function isLoadingValue(value: unknown): value is Loading {
    return value === loading || value instanceof LoadingToken
}

//
// Error type for load failures
//
export class LoadError extends Error {
    constructor(public readonly cause: unknown, message?: string) {
        super(
            message ?? (cause instanceof Error ? cause.message : String(cause))
        )
    }
}

//
// Basic loadable types
//
export type Reaction<Start, Result> = Start | Result
export type Loadable<T> = Reaction<Loading, T | LoadError>
export type Loaded<T> = Exclude<T, Loading | LoadError>

/**
 * Checks if a loadable value has fully loaded (i.e., is neither `loading`
 * nor an error).
 */
export function hasLoaded<T>(loadable: Loadable<T>): loadable is Loaded<T> {
    return !isLoadingValue(loadable) && !loadFailed(loadable)
}

/**
 * Checks if a loadable value represents a load failure (LoadError).
 */
export function loadFailed<T>(loadable: Loadable<T>): loadable is LoadError {
    return loadable instanceof LoadError
}

/**
 * If `loadable` is loaded, apply `mapper`; if error or loading, return as-is.
 */
export function map<T, R>(loadable: Loadable<T>, mapper: (loaded: T) => R): Loadable<R> {
    if (loadFailed(loadable)) return loadable
    if (isLoadingValue(loadable)) return loadable
    return mapper(loadable)
}

/**
 * If any provided loadable is not loaded, returns `loading`;
 * otherwise returns an array of loaded values.
 */
export function all<T extends Loadable<unknown>[]>(...loadables: T): Loadable<{ [K in keyof T]: Loaded<T[K]> }> {
    if (loadables.some(loadable => !hasLoaded(loadable))) {
        // We return the symbol for now; you could return `newLoadingToken()`
        // if you want a unique token each time.
        return loading
    }
    return loadables.map(loadable => loadable) as { [K in keyof T]: Loaded<T[K]> }
}

/**
 * Convert a loadable to `undefined` if not fully loaded, or the loaded value otherwise.
 */
export function toOptional<T>(loadable: Loadable<T>): T | undefined {
    return hasLoaded(loadable) ? loadable : undefined
}

/**
 * Returns the loaded value if `loadable` is fully loaded, otherwise `defaultValue`.
 */
export function orElse<T, R>(loadable: Loadable<T>, defaultValue: R): T | R {
    return hasLoaded(loadable) ? loadable : defaultValue
}

/**
 * For loadables that could be `null` or `undefined`, checks if it’s fully loaded and non-nullish.
 */
export function isUsable<T>(loadable: Loadable<T | null | undefined>): loadable is T {
    return hasLoaded(loadable) && loadable != null
}

/**
 * A type for a function that fetches data and returns a promise, using an abort signal.
 */
export type Fetcher<T> = (signal: AbortSignal) => Promise<T>

/**
 * The options we can pass to useLoadable / useThen / useAllThen.
 */
export interface UseLoadableOptions<T = any> {
    /** A prefetched loadable value to use if available (for the fetcher-based overload). */
    prefetched?: Loadable<T>;
    /** Optional error handler callback. */
    onError?: (error: unknown) => void;
    /**
     * If true, once we have a loaded value, do NOT revert to `loading` on subsequent fetches;
     * instead, keep the old value until the new fetch finishes or fails.
     */
    hideReload?: boolean;
}

/**
 * A custom hook that manages state with timestamps, so we can ignore stale updates.
 */
export function useLatestState<T>(
    initial: T
): [T, (value: T | ((current: T) => T), loadStart?: TimeStamp) => void, TimeStamp] {
    const [value, setValue] = useState<{ value: T; loadStart: TimeStamp }>({
        value: initial,
        loadStart: 0,
    })

    function updateValue(
        newValue: T | ((current: T) => T),
        loadStart: TimeStamp = currentTimestamp()
    ) {
        setValue(current => {
            if (current.loadStart > loadStart) {
                // Ignore updates with an older timestamp.
                return current
            }
            const nextValue =
                typeof newValue === "function"
                    ? (newValue as (c: T) => T)(current.value)
                    : newValue
            return {
                value: nextValue,
                loadStart,
            }
        })
    }

    return [value.value, updateValue, value.loadStart]
}

//
// Internal: just for debugging
//
const currentlyLoading = new Set<number>()
// @ts-ignore
window.currentlyLoading = currentlyLoading

/**
 * Overload #1 (waitable, readyCondition, fetcher).
 * Overload #2 (fetcher, deps, options?).
 */
export function useLoadable<W, R>(
    waitable: W,
    readyCondition: (loaded: W) => boolean,
    fetcher: (loaded: W, abort: AbortSignal) => Promise<R>,
    dependencies: DependencyList,
    optionsOrOnError?: ((e: unknown) => void) | UseLoadableOptions<R>
): Loadable<R>;
export function useLoadable<T>(
    fetcher: Fetcher<T>,
    deps: DependencyList,
    options?: UseLoadableOptions<T>
): Loadable<T>;

export function useLoadable<T, W, R>(
    fetcherOrWaitable: Fetcher<T> | W,
    depsOrReadyCondition: DependencyList | ((loaded: W) => boolean),
    optionsOrFetcher?: UseLoadableOptions<T> | ((loaded: W, abort: AbortSignal) => Promise<R>),
    dependencies: DependencyList = [],
    lastParam?: ((e: unknown) => void) | UseLoadableOptions<R>
): Loadable<T> | Loadable<R> {
    // CASE 1: waitable + readyCondition + fetcher
    if (typeof depsOrReadyCondition === "function") {
        const waitable = fetcherOrWaitable as W
        const readyCondition = depsOrReadyCondition as (loaded: W) => boolean
        const fetcher = optionsOrFetcher as (loaded: W, abort: AbortSignal) => Promise<R>

        let onErrorCb: ((e: unknown) => void) | undefined
        let hideReload = false

        if (typeof lastParam === "function") {
            onErrorCb = lastParam
        } else if (lastParam && typeof lastParam === "object") {
            onErrorCb = lastParam.onError
            hideReload = !!lastParam.hideReload
        }

        const [value, setValue] = useLatestState<Loadable<R>>(loading)
        const abort = useAbort()

        const ready = readyCondition(waitable)
        useEffect(() => {
            const startTime = currentTimestamp()

            // Only revert to 'loading' if hideReload=false OR we’re not loaded yet.
            if (!hideReload || !hasLoaded(value)) {
                setValue(loading, startTime)
            }

            if (ready) {
                currentlyLoading.add(startTime)
                const signal = abort()
                fetcher(waitable, signal)
                    .then(result => {
                        setValue(result, startTime)
                    })
                    .catch(e => {
                        onErrorCb?.(e)
                        setValue(new LoadError(e), startTime)
                    })
                    .finally(() => {
                        currentlyLoading.delete(startTime)
                        if (currentlyLoading.size === 0 && "prerenderReady" in window) {
                            (window as any).prerenderReady = true
                        }
                    })
            }

            return () => {
                abort()
                currentlyLoading.delete(startTime)
            }
        }, [...dependencies, ready, hideReload])

        return value
    }

    // CASE 2: fetcher + deps + options
    const fetcher = fetcherOrWaitable as Fetcher<T>
    const deps = depsOrReadyCondition as DependencyList
    const options = optionsOrFetcher as UseLoadableOptions<T> | undefined

    // We piggyback on the waitable-based overload with a "dummy" waitable always ready.
    return useLoadable(
        loading, // Waitable
        () => true, // always "ready"
        async (_ignored, signal) => {
            // If we have a prefetched loadable:
            if (options?.prefetched !== undefined) {
                return options.prefetched
            }
            // Otherwise, fetch for real:
            return fetcher(signal)
        },
        deps,
        {
            onError: options?.onError,
            hideReload: options?.hideReload,
        }
    ) as Loadable<T>
}

/**
 * Fetches data based on a loaded value, returning a loadable result.
 * `hideReload` can be passed as part of `options` to avoid reverting to `loading`.
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
    )
}

/**
 * Waits for multiple loadables to be loaded, then calls `fetcher`.
 * Also supports `hideReload` in the `options`.
 */
type UnwrapLoadable<T> = T extends Loadable<infer U> ? U : never
type LoadableParameters<T extends Loadable<any>[]> = { [K in keyof T]: UnwrapLoadable<T[K]> }

export function useAllThen<T extends Loadable<any>[], R>(
    loadables: [...T],
    fetcher: (...args: [...LoadableParameters<T>, AbortSignal]) => Promise<R>,
    dependencies: DependencyList = loadables,
    options?: UseLoadableOptions<R>
): Loadable<R> {
    // Combine them into one loadable
    const combined = all(...loadables)
    // Then chain off it
    return useThen(
        combined,
        (loadedValues, signal) => fetcher(...(loadedValues as unknown as LoadableParameters<T>), signal),
        dependencies,
        options
    )
}

/**
 * A version of `useLoadable` that returns `[loadable, cleanupFunc]`.
 * Calling `cleanupFunc()` aborts any in-flight request.
 */
export function useLoadableWithCleanup<W, R>(
    waitable: W,
    readyCondition: (loaded: W) => boolean,
    fetcher: (loaded: W, abort: AbortSignal) => Promise<R>,
    dependencies: DependencyList,
    optionsOrOnError?: ((e: unknown) => void) | UseLoadableOptions<R>
): [Loadable<R>, () => void];
export function useLoadableWithCleanup<T>(
    fetcher: Fetcher<T>,
    deps: DependencyList,
    options?: UseLoadableOptions<T>
): [Loadable<T>, () => void];

export function useLoadableWithCleanup<T, W, R>(
    fetcherOrWaitable: Fetcher<T> | W,
    depsOrReadyCondition: DependencyList | ((loaded: W) => boolean),
    optionsOrFetcher?: UseLoadableOptions<T> | ((loaded: W, abort: AbortSignal) => Promise<R>),
    dependencies: DependencyList = [],
    lastParam?: ((e: unknown) => void) | UseLoadableOptions<R>
): [Loadable<T> | Loadable<R>, () => void] {
    const [value, setValue] = useLatestState<Loadable<any>>(loading)
    const abortControllerRef = useRef<AbortController | null>(null)

    let isCase1 = false
    let waitableVal: W | undefined
    let readyFn: ((w: W) => boolean) | undefined
    let actualFetcher: ((w: W, signal: AbortSignal) => Promise<any>) | undefined
    let hideReload = false
    let onErrorCb: ((e: unknown) => void) | undefined
    let deps: DependencyList

    // Distinguish the two overload shapes:
    if (typeof depsOrReadyCondition === "function") {
        // CASE 1
        isCase1 = true
        waitableVal = fetcherOrWaitable as W
        readyFn = depsOrReadyCondition as (w: W) => boolean
        actualFetcher = optionsOrFetcher as (w: W, signal: AbortSignal) => Promise<R>
        deps = dependencies

        if (typeof lastParam === "function") {
            onErrorCb = lastParam
        } else if (lastParam && typeof lastParam === "object") {
            onErrorCb = lastParam.onError
            hideReload = !!lastParam.hideReload
        }
    } else {
        // CASE 2
        const fetcher = fetcherOrWaitable as Fetcher<T>
        const case2Deps = depsOrReadyCondition as DependencyList
        const options = optionsOrFetcher as UseLoadableOptions<T> | undefined

        onErrorCb = options?.onError
        hideReload = !!options?.hideReload
        deps = case2Deps

        // Always ready in case 2
        readyFn = () => true

        // We ensure the returned Promise is always T (or throws),
        // not `T | loading | LoadError`.
        actualFetcher = async (_ignored: W, signal: AbortSignal) => {
            if (options?.prefetched !== undefined) {
                if (options.prefetched === loading) {
                    // If prefetched is `loading` (symbol), just fetch normally
                    return fetcher(signal)
                } else if (options.prefetched instanceof LoadError) {
                    // If it's an error, throw it
                    throw options.prefetched
                } else if (isLoadingValue(options.prefetched)) {
                    // If it's a LoadingToken, also do a real fetch or return?
                    // For simplicity, let's just do a real fetch:
                    return fetcher(signal)
                } else {
                    // Otherwise it's a T
                    return options.prefetched
                }
            }
            // Normal fetch
            return fetcher(signal)
        }
    }

    useEffect(() => {
        const startTime = currentTimestamp()
        const isReady = readyFn?.(waitableVal as W) ?? true

        // If hideReload=false or current value is not loaded, revert to loading
        if (!hideReload || !hasLoaded(value)) {
            setValue(loading, startTime)
        }

        if (isReady && actualFetcher) {
            abortControllerRef.current = new AbortController()
            const signal = abortControllerRef.current.signal

            currentlyLoading.add(startTime)
            actualFetcher(waitableVal as W, signal)
                .then(result => {
                    setValue(result, startTime)
                })
                .catch(e => {
                    onErrorCb?.(e)
                    setValue(new LoadError(e), startTime)
                })
                .finally(() => {
                    currentlyLoading.delete(startTime)
                    if (currentlyLoading.size === 0 && "prerenderReady" in window) {
                        (window as any).prerenderReady = true
                    }
                })
        }

        return () => {
            abortControllerRef.current?.abort()
            currentlyLoading.delete(startTime)
        }
    }, [
        isCase1,
        waitableVal,
        readyFn,
        actualFetcher,
        hideReload,
        onErrorCb,
        value,
        setValue,
        ...deps
    ])

    const cleanupFunc = useCallback(() => {
        abortControllerRef.current?.abort()
    }, [])

    return [value, cleanupFunc]
}