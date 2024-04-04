import {DependencyList, useEffect, useMemo, useState} from "react"
import {currentTimestamp, TimeStamp, useAbort} from "./utils"

export const loading: unique symbol = Symbol("loading")

export type Reaction<Start, Result> = Start | Result
export type Loading = typeof loading

export class LoadError extends Error {
    constructor(public readonly cause: unknown, message?: string) {
        super(message)
    }
}

/**
 * Represents a value that can be in a loading state or already loaded.
 */
export type Loadable<T> = Reaction<Loading, T | LoadError>

export type Loaded<T> = Exclude<T, Loading | LoadError>

/**
 * Checks if a loadable value is loaded (i.e., not in the loading state).
 * @param loadable - The loadable value to check.
 * @returns True if the value is loaded, false otherwise.
 */
export function hasLoaded<T>(loadable: Loadable<T>): loadable is Loaded<T> {
    return loadable !== loading && !loadFailed(loadable)
}

/**
 * Applies a mapper function to a loaded value, or returns loading if the value is not loaded.
 * @param loadable - The loadable value to map.
 * @param mapper - The mapper function to apply to the loaded value.
 * @returns The result of applying the mapper function to the loaded value, or loading if not loaded.
 */
export function map<T, R>(loadable: Loadable<T>, mapper: (loaded: T) => R): Loadable<R> {
    if (!hasLoaded(loadable)) {
        return loading
    } else {
        return mapper(loadable)
    }
}

type All<T extends Loadable<unknown>[]> = { [K in keyof T]: Loaded<T[K]> }

type UnwrapLoadable<T> = T extends Loadable<infer U> ? U : never
type LoadableParameters<T extends Loadable<any>[]> = { [K in keyof T]: UnwrapLoadable<T[K]> }

/**
 * Waits for all loadables to load, then returns the loaded values as an array
 * @param loadables - The loadable values to wait for.
 * @returns The loaded values as an array.
 */
export function all<T extends Loadable<unknown>[]>(...loadables: T): Loadable<All<T>> {
    if (loadables.some(loadable => !hasLoaded(loadable))) {
        return loading
    }
    return loadables.map(loadable => loadable) as Loadable<All<T>>
}

export function loadFailed<T>(loadable: Loadable<T>): loadable is LoadError {
    return loadable instanceof LoadError
}

export function useAll<T extends Loadable<unknown>[]>(...loadables: T): Loadable<All<T>> {
    return useMemo(() => all(...loadables), loadables)
}

/**
 * Fetches data based on multiple loaded values. The hook returns a loadable value.
 * @param loadables - The loadable values to use as input for fetching data.
 * @param fetcher - The function to fetch data based on the loaded values.
 * @param dependencies - The list of dependencies for the useEffect hook.
 * @returns A loadable value representing the fetched data.
 */
export function useAllThen<T extends Loadable<any>[], R>(
    loadables: [...T],
    fetcher: (...args: LoadableParameters<T>) => Promise<R>,
    dependencies: DependencyList = loadables
): Loadable<R> {
    return useThen(all(...loadables), loaded => fetcher(...(loaded as LoadableParameters<T>)), dependencies)
}

/**
 * Gets the loaded value or a default value if the loadable value is not loaded.
 * @param loadable - The loadable value.
 * @param defaultValue - The default value to return if the loadable value is not loaded.
 * @returns The loaded value or the default value.
 */
export function orElse<T, R>(loadable: Loadable<T>, defaultValue: R): T | R {
    if (hasLoaded(loadable)) {
        return loadable
    }
    return defaultValue
}

/**
 * Converts a loadable value to an optional value (undefined if not loaded).
 * @param loadable - The loadable value.
 * @returns The loaded value or undefined.
 */
export function toOptional<T>(loadable: Loadable<T>) {
    return orElse(loadable, undefined)
}

/**
 * Checks if a loadable value is usable (i.e., not null, not undefined, and loaded).
 * @param loadable - The loadable value to check.
 * @returns True if the value is usable, false otherwise.
 */
export function isUsable<T>(loadable: Loadable<T | null | undefined>): loadable is T {
    return hasLoaded(loadable) && loadable !== undefined && loadable !== null
}

/**
 * Represents a function that fetches data and returns a promise.
 */
export type Fetcher<T> = (signal: AbortSignal) => Promise<T>

/**
 * Represents a value or a fetcher function.
 */
export type ValueOrFetcher<T> = T | Fetcher<T>

/**
 * Fetches data based on a loaded value. The hook returns a loadable value.
 * @param loadable - The loadable value to use as input for fetching data.
 * @param fetcher - The function to fetch data based on the loaded value.
 * @param dependencies - The list of dependencies for the useEffect hook.
 * @param onError - An optional error handler.
 * @returns A loadable value representing the fetched data.
 */
export function useThen<T, R>(
    loadable: Loadable<T>,
    fetcher: (loaded: T, abort: AbortSignal) => Promise<R>,
    dependencies: DependencyList = [],
    onError?: (e: unknown) => any
): Loadable<R> {
    return useLoadable(
        loadable,
        loaded => hasLoaded(loaded),
        async (l, abort) => map(l, l => fetcher(l, abort)),
        dependencies,
        onError
    )
}

/**
 * Fetches data based on a loaded value using a synchronous fetcher. The hook returns a loadable value.
 * @param loadable - The loadable value to use as input for fetching data.
 * @param mapper - The synchronous function to fetch data based on the loaded value.
 * @param dependencies - The list of dependencies for the useMemo hook.
 * @param onError - An optional error handler.
 * @returns A loadable value representing the fetched data.
 */
export function useThenSync<T, R>(
    loadable: Loadable<T>,
    mapper: (loaded: T) => R,
    dependencies: DependencyList = [],
    onError?: (e: unknown) => any
): Loadable<R> {
    return useMemo(() => {
        if (hasLoaded(loadable)) {
            try {
                return mapper(loadable)
            } catch (e) {
                if (onError) {
                    onError(e)
                }
                return new LoadError(e)
            }
        }
        return loading
    }, [loadable, ...dependencies])
}

/**
 * Mutates a value based on a change condition. The hook returns the current value and a setter function.
 * @param t - The initial value.
 * @param changeCondition - The condition for updating the value.
 * @returns A tuple containing the current value and a setter function.
 */
export function useMutate<T>(
    t: T,
    changeCondition: (next: T) => unknown = t => t
): [T, (next: T | ((t: T) => T)) => void] {
    const [value, setValue] = useState(t)
    useEffect(() => setValue(t), [changeCondition(t)])
    return [value, setValue]
}

const currentlyLoading = new Set<number>()
// @ts-ignore
window.currentlyLoading = currentlyLoading

/**
 * Fetches data based on a waitable value. The hook returns a loadable value.
 * @param waitable - The waitable value to use as input for fetching data.
 * @param readyCondition - The condition for determining if the waitable value is ready for fetching.
 * @param fetcher - The function to fetch data based on the waitable value.
 * @param dependencies - The list of dependencies for the useEffect hook.
 * @param onError? - An optional error handler.
 * @returns A loadable value representing the fetched data.
 */
export function useLoadable<W, R>(
    waitable: W,
    readyCondition: (loaded: W) => boolean,
    fetcher: (loaded: W, abort: AbortSignal) => Promise<R>,
    dependencies: React.DependencyList,
    onError?: (e: unknown) => any
): Loadable<R>
export function useLoadable<T>(
    fetcher: Fetcher<T>,
    deps: React.DependencyList,
    options?: { prefetched?: Loadable<T>; onError?: (e: unknown) => any }
): Loadable<T>
export function useLoadable<T, W, R>(
    fetcherOrWaitable: Fetcher<T> | W,
    depsOrReadyCondition: React.DependencyList | ((loaded: W) => boolean),
    optionsOrFetcher?:
        | {
        prefetched?: Loadable<T>
        onError?: (e: unknown) => any
    }
        | ((loaded: W, abort: AbortSignal) => Promise<R>),
    dependencies: React.DependencyList = [],
    onError?: (e: unknown) => any
): Loadable<T> | Loadable<R> {
    if (typeof depsOrReadyCondition === "function") {
        const waitable = fetcherOrWaitable as W
        const readyCondition = depsOrReadyCondition as (loaded: W) => boolean
        const fetcher = optionsOrFetcher as (loaded: W, abort: AbortSignal) => Promise<R>
        const [value, setValue] = useLatestState<Loadable<R>>(loading)
        const abort = useAbort()

        const ready = readyCondition(waitable);
        useEffect(() => {
            const startTime = currentTimestamp();
            setValue(loading, startTime)
            if (ready) {
                currentlyLoading.add(startTime)
                const newSignal = abort()
                fetcher(waitable, newSignal)
                    .then(v => {
                        const isFunction = typeof v === "function"
                        setValue(isFunction ? () => v : v, startTime)
                    })
                    .catch(e => {
                        if (onError) {
                            onError(e)
                        }
                        setValue(new LoadError(e), startTime)
                    })
                    .finally(() => {
                        currentlyLoading.delete(startTime)
                        // if prerender is enabled, and there are no more loading requests, we set prerenderReady to true
                        if (currentlyLoading.size === 0 && "prerenderReady" in window) {
                            window.prerenderReady = true
                        }
                    })
            }
            return () => {
                abort()
                currentlyLoading.delete(startTime)
            }
        }, [...dependencies, ready])

        return value
    } else {
        const fetcher = fetcherOrWaitable as Fetcher<T>
        const deps = depsOrReadyCondition as React.DependencyList
        const options = optionsOrFetcher as { prefetched?: Loadable<T>; onError?: (e: unknown) => any }
        return useLoadable(
            loading,
            () => true,
            async (loaded, abort) => options?.prefetched ?? fetcher(abort),
            deps,
            options?.onError
        )
    }
}

/**
 * Manages state with the ability to ignore outdated updates.
 * The hook returns the current value, a setter function, and the timestamp of the last update.
 * @param initial - The initial value.
 * @returns A tuple containing the current value, a setter function, and the timestamp of the last update.
 */
export function useLatestState<T>(
    initial: T
): [T, (value: T | ((current: T) => T), loadStart?: TimeStamp) => void, TimeStamp] {
    const [value, setValue] = useState<{ value: T; loadStart: TimeStamp }>({
        value: initial,
        loadStart: 0,
    })

    function updateValue(value: T | ((current: T) => T), loadStart: TimeStamp = currentTimestamp()) {
        setValue(current => {
            if (current.loadStart > loadStart) {
                // Ignore updates with an older timestamp.
                return current
            }

            const nextValue = value instanceof Function ? value(current.value) : value
            return {
                value: nextValue,
                loadStart,
            }
        })
    }

    return [value.value, updateValue, value.loadStart]
}
