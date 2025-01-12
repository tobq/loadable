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
import {currentTimestamp, TimeStamp, useAbort} from "./utils";

export const loading: unique symbol = Symbol("loading")

export type Reaction<Start, Result> = Start | Result
export type Loading = typeof loading

export class LoadError extends Error {
    constructor(public readonly cause: unknown, message?: string) {
        super(
            message ??
            (cause instanceof Error ? cause.message : String(cause))
        )
    }
}

/**
 * Represents a value that can be in a loading state or already loaded.
 */
export type Loadable<T> = Reaction<Loading, T | LoadError>

/**
 * A helper type for the loaded portion of a Loadable.
 */
export type Loaded<T> = Exclude<T, Loading | LoadError>

/**
 * Checks if a loadable value has fully loaded (i.e., is neither `loading` nor an error).
 */
export function hasLoaded<T>(loadable: Loadable<T>): loadable is Loaded<T> {
    return loadable !== loading && !loadFailed(loadable)
}

/**
 * Checks if a loadable value represents a load failure (LoadError).
 */
export function loadFailed<T>(loadable: Loadable<T>): loadable is LoadError {
    return loadable instanceof LoadError
}

/**
 * Symbolic "map" for loadable. If loaded, apply `mapper`; if error or loading, return as-is.
 */
export function map<T, R>(loadable: Loadable<T>, mapper: (loaded: T) => R): Loadable<R> {
    if (loadFailed(loadable)) return loadable
    if (loadable === loading) return loading
    return mapper(loadable)
}

/**
 * If any provided loadable is not loaded, returns `loading`; otherwise an array of loaded values.
 */
export function all<T extends Loadable<unknown>[]>(...loadables: T): Loadable<{ [K in keyof T]: Loaded<T[K]> }> {
    if (loadables.some(loadable => !hasLoaded(loadable))) {
        return loading
    }
    return loadables.map(loadable => loadable) as { [K in keyof T]: Loaded<T[K]> }
}

/**
 * Convert a loadable to undefined if not loaded, otherwise return the loaded value.
 */
export function toOptional<T>(loadable: Loadable<T>): T | undefined {
    return hasLoaded(loadable) ? loadable : undefined
}

/**
 * Returns `loadable` if loaded, otherwise `defaultValue`.
 */
export function orElse<T, R>(loadable: Loadable<T>, defaultValue: R): T | R {
    return hasLoaded(loadable) ? loadable : defaultValue
}

/**
 * For loadables that could be `null` or `undefined`, checks if it’s fully loaded and not nullish.
 */
export function isUsable<T>(loadable: Loadable<T | null | undefined>): loadable is T {
    return hasLoaded(loadable) && loadable != null
}

/**
 * A type for a function that fetches data and returns a promise, using an abort signal.
 */
export type Fetcher<T> = (signal: AbortSignal) => Promise<T>

/**
 * These are the options we can pass to useLoadable / useThen / useAllThen.
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

/**
 * Overload #1: useLoadable(waitable, readyCondition, fetcher, deps, (options? / onError?))
 * Overload #2: useLoadable(fetcher, deps, options?)
 */
const currentlyLoading = new Set<number>() // For debugging
// @ts-ignore
window.currentlyLoading = currentlyLoading

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

        // onError or options
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

            // Only revert to 'loading' if hideReload=false OR it’s not loaded yet.
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
                        if (onErrorCb) {
                            onErrorCb(e)
                        }
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

    // Reuse logic by calling the waitable-based overload:
    return useLoadable(
        loading, // waitable
        () => true, // always ready
        async (_ignored, signal) => {
            if (options?.prefetched !== undefined) {
                return options.prefetched
            }
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
