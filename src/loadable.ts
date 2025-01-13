import {DependencyList, useCallback, useEffect, useRef, useState} from "react"
import {currentTimestamp, TimeStamp, useAbort} from "./utils"

/** A class that represents “loading” at a specific start time. */
export class LoadingToken {
    constructor(public readonly startTime: TimeStamp = currentTimestamp()) {}
}

/** Type alias for the loading state. */
export type Loading = LoadingToken

/**
 * Reaction is basically a union of a "start" type (LoadingToken) or a result type (T | LoadError).
 * So a loadable value can be in a "loading" state or a (T | LoadError) state.
 */
export type Reaction<Start, Result> = Start | Result

/**
 * Our custom error for load failures.
 */
export class LoadError extends Error {
    constructor(public readonly cause: unknown, message?: string) {
        super(
            message ?? (cause instanceof Error ? cause.message : String(cause))
        )
    }
}

/**
 * Represents a value that can be in a loading state or already loaded (or error).
 */
export type Loadable<T> = Reaction<Loading, T | LoadError>

/** A helper type for the loaded portion of a Loadable. */
export type Loaded<T> = Exclude<T, Loading | LoadError>

/**
 * Checks if a loadable value has fully loaded (i.e., it is neither LoadingToken nor LoadError).
 */
export function hasLoaded<T>(loadable: Loadable<T>): loadable is Loaded<T> {
    return !(loadable instanceof LoadingToken) && !loadFailed(loadable)
}

/**
 * Checks if a loadable value is a load failure (LoadError).
 */
export function loadFailed<T>(loadable: Loadable<T>): loadable is LoadError {
    return loadable instanceof LoadError
}

/**
 * Symbolic "map" for loadable. If loaded, apply `mapper`; if error or loading, return as-is.
 */
export function map<T, R>(loadable: Loadable<T>, mapper: (loaded: T) => R): Loadable<R> {
    if (loadFailed(loadable)) return loadable
    if (loadable instanceof LoadingToken) return new LoadingToken() // propagate a new loading token
    return mapper(loadable)
}

/**
 * If any provided loadable is not loaded, returns a new LoadingToken; otherwise an array of loaded values.
 */
export function all<T extends Loadable<unknown>[]>(...loadables: T): Loadable<{ [K in keyof T]: Loaded<T[K]> }> {
    if (loadables.some(loadable => !hasLoaded(loadable))) {
        return new LoadingToken()
    }
    // All are loaded, so cast to the array of loaded values
    return loadables.map(loadable => loadable) as { [K in keyof T]: Loaded<T[K]> }
}

/**
 * Convert a loadable to `undefined` if not loaded, otherwise return the loaded value.
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
 * For loadables that might be nullish, checks if it’s fully loaded and not null/undefined.
 */
export function isUsable<T>(loadable: Loadable<T | null | undefined>): loadable is T {
    return hasLoaded(loadable) && loadable != null
}

/**
 * A type for a function that fetches data and returns a promise, using an abort signal.
 */
export type Fetcher<T> = (signal: AbortSignal) => Promise<T>

/**
 * Options for useLoadable / useThen / useAllThen.
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
 * A custom hook that manages a value with a timestamp, so that stale updates can be ignored.
 */
export function useLatestState<T>(
    initial: T
): [T, (value: T | ((current: T) => T), loadStart?: TimeStamp) => void, TimeStamp] {
    const [value, setValue] = useState<{
        value: T;
        loadStart: TimeStamp;
    }>({
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

/** For debugging: track all in-flight loads by their startTime. */
const currentlyLoading = new Set<number>()
// @ts-ignore
window.currentlyLoading = currentlyLoading

/**
 * Overload #1: useLoadable(waitable, readyCondition, fetcher, deps, (options? / onError?))
 * Overload #2: useLoadable(fetcher, deps, options?)
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

        const [value, setValue] = useLatestState<Loadable<R>>(new LoadingToken())
        const abort = useAbort()

        const ready = readyCondition(waitable)
        useEffect(() => {
            const startTime = currentTimestamp()

            // Only revert to a new loading token if hideReload=false OR it’s not loaded yet.
            if (!hideReload || !hasLoaded(value)) {
                setValue(new LoadingToken(), startTime)
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

    // Reuse logic by calling the waitable-based overload:
    return useLoadable(
        new LoadingToken(), // waitable
        () => true,        // always "ready"
        async (_ignored, signal) => {
            if (options?.prefetched !== undefined) {
                // If prefetched is a LoadingToken, treat it as "not actually loaded yet"
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
        async (val, abort) => {
            // val might be a LoadingToken or a T, so we map it first
            return map(val, v => fetcher(v, abort))
        },
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
        (loadedValues, signal) =>
            fetcher(...(loadedValues as unknown as LoadableParameters<T>), signal),
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
    const [value, setValue] = useLatestState<Loadable<any>>(new LoadingToken())
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

        // We'll ensure the returned Promise is always T (or throws).
        actualFetcher = async (_ignored: W, signal: AbortSignal) => {
            if (options?.prefetched !== undefined) {
                // If prefetched is a LoadingToken, we can decide whether to skip or do a real fetch
            }
            return fetcher(signal)
        }
    }

    useEffect(() => {
        const startTime = currentTimestamp()
        const isReady = readyFn?.(waitableVal as W) ?? true

        // If hideReload=false or current value is not loaded, revert to newLoadingToken()
        if (!hideReload || !hasLoaded(value)) {
            setValue(new LoadingToken(), startTime)
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
