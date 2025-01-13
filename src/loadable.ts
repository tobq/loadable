import {
    DependencyList,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react"

/** A type representing an integer timestamp (ms since epoch or any monotonic style). */
export type TimeStamp = number
/** Simple function returning the current time. */
export function currentTimestamp(): TimeStamp {
    return Date.now()
}

/** A helper hook that provides a stable abort function each render. */
export function useAbort() {
    const abortControllerRef = useRef<AbortController | null>(null)
    return useCallback(() => {
        if (abortControllerRef.current) {
            // If we already had a controller, abort it
            abortControllerRef.current.abort()
        }
        abortControllerRef.current = new AbortController()
        return abortControllerRef.current.signal
    }, [])
}

// ---------------------------------------------
// Loading Symbol + LoadingToken
// ---------------------------------------------

export class LoadingToken {
    constructor(
        /** When this token was created. */
        public readonly startTime: TimeStamp = currentTimestamp()
    ) {}
}

/** A unique symbol representing 'loading'. */
export const loading: unique symbol = Symbol("loading")

/** A union type that can be either the old symbol or the new class-based token. */
export type Loading = typeof loading | LoadingToken

/** Check if a value is in a "loading" state. */
export function isLoadingValue(value: unknown): value is Loading {
    return value === loading || value instanceof LoadingToken
}

// ---------------------------------------------
// Error for load failures
// ---------------------------------------------

export class LoadError extends Error {
    constructor(public readonly cause: unknown, message?: string) {
        super(
            message ?? (cause instanceof Error ? cause.message : String(cause))
        )
    }
}

// ---------------------------------------------
// Loadable types
// ---------------------------------------------

export type Reaction<Start, Result> = Start | Result
export type Loadable<T> = Reaction<Loading, T | LoadError>
export type Loaded<T> = Exclude<T, Loading | LoadError>

export function hasLoaded<T>(loadable: Loadable<T>): loadable is Loaded<T> {
    return !isLoadingValue(loadable) && !loadFailed(loadable)
}
export function loadFailed<T>(loadable: Loadable<T>): loadable is LoadError {
    return loadable instanceof LoadError
}
export function map<T, R>(loadable: Loadable<T>, mapper: (loaded: T) => R): Loadable<R> {
    if (loadFailed(loadable)) return loadable
    if (isLoadingValue(loadable)) return loadable
    return mapper(loadable)
}
export function all<T extends Loadable<unknown>[]>(...loadables: T): Loadable<{ [K in keyof T]: Loaded<T[K]> }> {
    if (loadables.some(l => !hasLoaded(l))) {
        return loading
    }
    return loadables.map(l => l) as { [K in keyof T]: Loaded<T[K]> }
}
export function toOptional<T>(loadable: Loadable<T>): T | undefined {
    return hasLoaded(loadable) ? loadable : undefined
}
export function orElse<T, R>(loadable: Loadable<T>, defaultValue: R): T | R {
    return hasLoaded(loadable) ? loadable : defaultValue
}
export function isUsable<T>(loadable: Loadable<T | null | undefined>): loadable is T {
    return hasLoaded(loadable) && loadable != null
}

// ---------------------------------------------
// Basic fetcher type
// ---------------------------------------------

export type Fetcher<T> = (signal: AbortSignal) => Promise<T>

// ---------------------------------------------
// Caching shapes
// ---------------------------------------------

/** Single object shape for caching. */
export interface CacheOption {
    /** Key to store in the cache. */
    key: string
    /** Which store to use for caching. Defaults to localStorage. */
    store?: "memory" | "localStorage" | "indexedDB"
}

/** Helper function to parse the `cache` field. */
function parseCacheOption(
    cache?: string | CacheOption
): { key?: string; store: "memory" | "localStorage" | "indexedDB" } {
    if (!cache) {
        return { key: undefined, store: "localStorage" }
    }
    if (typeof cache === "string") {
        // If user passed a string, that is the cache key, default to localStorage
        return { key: cache, store: "localStorage" }
    }
    // Otherwise, user passed an object { key, store? }
    return {
        key: cache.key,
        store: cache.store ?? "localStorage",
    }
}

// ---------------------------------------------
// Our caching utilities
// ---------------------------------------------

// In-memory cache
const memoryCache = new Map<string, unknown>()

/** Read from chosen cache store. */
async function readCache<T>(
    key: string,
    store: "memory" | "localStorage" | "indexedDB"
): Promise<T | undefined> {
    switch (store) {
        case "memory": {
            return memoryCache.get(key) as T | undefined
        }
        case "localStorage": {
            const json = window.localStorage.getItem(key)
            if (!json) return undefined
            try {
                return JSON.parse(json) as T
            } catch {
                return undefined
            }
        }
        case "indexedDB": {
            return await readFromIndexedDB<T>(key)
        }
    }
}

/** Write to chosen cache store. */
async function writeCache<T>(
    key: string,
    data: T,
    store: "memory" | "localStorage" | "indexedDB"
): Promise<void> {
    switch (store) {
        case "memory": {
            memoryCache.set(key, data)
            break
        }
        case "localStorage": {
            window.localStorage.setItem(key, JSON.stringify(data))
            break
        }
        case "indexedDB": {
            await writeToIndexedDB(key, data)
            break
        }
    }
}

/** Minimal IndexedDB logic. */
function openCacheDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("myReactCacheDB", 1)
        request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains("idbCache")) {
                db.createObjectStore("idbCache")
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

async function readFromIndexedDB<T>(key: string): Promise<T | undefined> {
    const db = await openCacheDB()
    return new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction("idbCache", "readonly")
        const store = tx.objectStore("idbCache")
        const getReq = store.get(key)
        getReq.onsuccess = () => resolve(getReq.result)
        getReq.onerror = () => reject(getReq.error)
    })
}

async function writeToIndexedDB<T>(key: string, data: T): Promise<void> {
    const db = await openCacheDB()
    return new Promise<void>((resolve, reject) => {
        const tx = db.transaction("idbCache", "readwrite")
        const store = tx.objectStore("idbCache")
        const putReq = store.put(data, key)
        putReq.onsuccess = () => resolve()
        putReq.onerror = () => reject(putReq.error)
    })
}

// ---------------------------------------------
// Options for useLoadable
// ---------------------------------------------

export interface UseLoadableOptions<T = any> {
    /** A prefetched loadable value, if available. */
    prefetched?: Loadable<T>
    /** Optional error callback. */
    onError?: (error: unknown) => void
    /**
     * If true, once we have a loaded value, do NOT revert to `loading` on subsequent fetches;
     * instead, keep the old value until the new fetch finishes or fails.
     */
    hideReload?: boolean

    /**
     * A single field for caching. Can be:
     * - a string, indicating the cache key (default store: localStorage)
     * - an object { key, store }.
     */
    cache?: string | CacheOption
}

// ---------------------------------------------
// A custom hook for state with timestamps
// ---------------------------------------------

export function useLatestState<T>(
    initial: T
): [T, (value: T | ((current: T) => T), loadStart?: TimeStamp) => void, TimeStamp] {
    const [value, setValue] = useState<{
        value: T
        loadStart: TimeStamp
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
                // Ignore older updates
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

// ---------------------------------------------
// For debugging (optional)
// ---------------------------------------------

const currentlyLoading = new Set<number>()
// @ts-ignore
if (typeof window !== "undefined") {
    ;(window as any).currentlyLoading = currentlyLoading
}

// ---------------------------------------------
// Overloads for useLoadable
// ---------------------------------------------

export function useLoadable<W, R>(
    waitable: W,
    readyCondition: (loaded: W) => boolean,
    fetcher: (loaded: W, abort: AbortSignal) => Promise<R>,
    dependencies: DependencyList,
    optionsOrOnError?: ((e: unknown) => void) | UseLoadableOptions<R>
): Loadable<R>

export function useLoadable<T>(
    fetcher: Fetcher<T>,
    deps: DependencyList,
    options?: UseLoadableOptions<T>
): Loadable<T>

// ---------------------------------------------
// Actual useLoadable implementation
// ---------------------------------------------
export function useLoadable<T, W, R>(
    fetcherOrWaitable: Fetcher<T> | W,
    depsOrReadyCondition: DependencyList | ((loaded: W) => boolean),
    optionsOrFetcher?:
        | UseLoadableOptions<T>
        | ((loaded: W, abort: AbortSignal) => Promise<R>),
    dependencies: DependencyList = [],
    lastParam?: ((e: unknown) => void) | UseLoadableOptions<R>
): Loadable<T> | Loadable<R> {
    // ============================
    // CASE 1: waitable + readyCondition + fetcher
    // ============================
    if (typeof depsOrReadyCondition === "function") {
        const waitable = fetcherOrWaitable as W
        const readyCondition = depsOrReadyCondition as (loaded: W) => boolean
        const fetcher = optionsOrFetcher as (
            loaded: W,
            abort: AbortSignal
        ) => Promise<R>

        let onErrorCb: ((e: unknown) => void) | undefined
        let hideReload = false
        let cacheObj: ReturnType<typeof parseCacheOption> = {
            key: undefined,
            store: "localStorage",
        }

        if (typeof lastParam === "function") {
            onErrorCb = lastParam
        } else if (lastParam && typeof lastParam === "object") {
            onErrorCb = lastParam.onError
            hideReload = !!lastParam.hideReload
            cacheObj = parseCacheOption(lastParam.cache)
        }

        const [value, setValue] = useLatestState<Loadable<R>>(loading)
        const abort = useAbort()

        const ready = readyCondition(waitable)

        useEffect(() => {
            const startTime = currentTimestamp()

            // If hideReload=false or not yet loaded, revert to 'loading'
            if (!hideReload || !hasLoaded(value)) {
                setValue(loading, startTime)
            }

            if (ready) {
                // Before fetching, try reading from cache (if provided)
                if (cacheObj.key) {
                    // Attempt to read
                    ;(async () => {
                        const cachedData = await readCache<R>(
                            cacheObj.key!,
                            cacheObj.store
                        )
                        if (cachedData !== undefined) {
                            // We found a valid cached value
                            // You could do stale-while-revalidate or just set it:
                            setValue(cachedData, startTime)
                        }
                        doFetch()
                    })()
                } else {
                    doFetch()
                }

                function doFetch() {
                    currentlyLoading.add(startTime)
                    const signal = abort()
                    fetcher(waitable, signal)
                        .then(result => {
                            // On success, write to cache if key
                            if (cacheObj.key) {
                                writeCache(cacheObj.key, result, cacheObj.store).catch(
                                    console.error
                                )
                            }
                            setValue(result, startTime)
                        })
                        .catch(e => {
                            onErrorCb?.(e)
                            setValue(new LoadError(e), startTime)
                        })
                        .finally(() => {
                            currentlyLoading.delete(startTime)
                            if (
                                currentlyLoading.size === 0 &&
                                typeof window !== "undefined" &&
                                "prerenderReady" in window
                            ) {
                                ;(window as any).prerenderReady = true
                            }
                        })
                }
            }

            return () => {
                abort()
                currentlyLoading.delete(startTime)
            }
        }, [...dependencies, ready, hideReload])

        return value
    }

    // ============================
    // CASE 2: fetcher + deps + options
    // ============================
    const fetcher = fetcherOrWaitable as Fetcher<T>
    const deps = depsOrReadyCondition as DependencyList
    const options = optionsOrFetcher as UseLoadableOptions<T> | undefined

    // Parse the cache field
    const { key: cacheKey, store: cacheStore } = parseCacheOption(options?.cache)

    // We'll piggyback on the waitable approach, with a "dummy" waitable always ready
    return useLoadable(
        loading,
        () => true,
        async (_ignored, signal) => {
            //
            // 1) Attempt to read from cache (if we have cacheKey)
            //
            if (cacheKey) {
                const cachedData = await readCache<T>(cacheKey, cacheStore)
                if (cachedData !== undefined) {
                    // Found a valid cached value
                    return cachedData
                }
            }

            //
            // 2) If there's a prefetched loadable
            //
            if (options?.prefetched !== undefined) {
                if (options.prefetched === loading) {
                    return fetcher(signal)
                } else if (options.prefetched instanceof LoadError) {
                    throw options.prefetched
                } else if (isLoadingValue(options.prefetched)) {
                    // e.g. a LoadingToken
                    return fetcher(signal)
                } else {
                    // Otherwise it's a T
                    if (cacheKey) {
                        await writeCache(cacheKey, options.prefetched, cacheStore)
                    }
                    return options.prefetched
                }
            }

            //
            // 3) Normal fetch
            //
            const data = await fetcher(signal)
            if (cacheKey) {
                await writeCache(cacheKey, data, cacheStore)
            }
            return data
        },
        deps,
        {
            onError: options?.onError,
            hideReload: options?.hideReload,
        }
    ) as Loadable<T>
}

// ---------------------------------------------
// useThen + useAllThen
// ---------------------------------------------

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

type UnwrapLoadable<T> = T extends Loadable<infer U> ? U : never
type LoadableParameters<T extends Loadable<any>[]> = {
    [K in keyof T]: UnwrapLoadable<T[K]>
}

export function useAllThen<T extends Loadable<any>[], R>(
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

// ---------------------------------------------
// useLoadableWithCleanup
// ---------------------------------------------

export function useLoadableWithCleanup<W, R>(
    waitable: W,
    readyCondition: (loaded: W) => boolean,
    fetcher: (loaded: W, abort: AbortSignal) => Promise<R>,
    dependencies: DependencyList,
    optionsOrOnError?: ((e: unknown) => void) | UseLoadableOptions<R>
): [Loadable<R>, () => void]

export function useLoadableWithCleanup<T>(
    fetcher: Fetcher<T>,
    deps: DependencyList,
    options?: UseLoadableOptions<T>
): [Loadable<T>, () => void]

export function useLoadableWithCleanup<T, W, R>(
    fetcherOrWaitable: Fetcher<T> | W,
    depsOrReadyCondition: DependencyList | ((loaded: W) => boolean),
    optionsOrFetcher?:
        | UseLoadableOptions<T>
        | ((loaded: W, abort: AbortSignal) => Promise<R>),
    dependencies: DependencyList = [],
    lastParam?: ((e: unknown) => void) | UseLoadableOptions<R>
): [Loadable<T> | Loadable<R>, () => void] {
    // Implementation combining both overload shapes:
    // Similar logic to useLoadable, but we keep a ref to the AbortController
    // and return a cleanup function.

    const [value, setValue] = useLatestState<Loadable<any>>(loading)
    const abortControllerRef = useRef<AbortController | null>(null)

    let isCase1 = false
    let waitableVal: W | undefined
    let readyFn: ((w: W) => boolean) | undefined
    let actualFetcher: ((w: W, signal: AbortSignal) => Promise<any>) | undefined
    let hideReload = false
    let onErrorCb: ((e: unknown) => void) | undefined
    let deps: DependencyList
    let cacheObj = parseCacheOption()

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
            cacheObj = parseCacheOption(lastParam.cache)
        }
    } else {
        // CASE 2
        const fetcher = fetcherOrWaitable as Fetcher<T>
        deps = depsOrReadyCondition as DependencyList
        const options = optionsOrFetcher as UseLoadableOptions<T> | undefined

        onErrorCb = options?.onError
        hideReload = !!options?.hideReload
        cacheObj = parseCacheOption(options?.cache)
        // always "ready"
        readyFn = () => true

        // We ensure the returned Promise is always T (or throws)
        actualFetcher = async (_ignored: W, signal: AbortSignal) => {
            // Read from cache if possible
            if (cacheObj.key) {
                const cachedData = await readCache<T>(cacheObj.key, cacheObj.store)
                if (cachedData !== undefined) {
                    return cachedData
                }
            }
            // If prefetched is available
            if (options?.prefetched !== undefined) {
                if (options.prefetched === loading) {
                    return fetcher(signal)
                } else if (options.prefetched instanceof LoadError) {
                    throw options.prefetched
                } else if (isLoadingValue(options.prefetched)) {
                    return fetcher(signal)
                } else {
                    // T
                    if (cacheObj.key) {
                        await writeCache(cacheObj.key, options.prefetched, cacheObj.store)
                    }
                    return options.prefetched
                }
            }
            // Normal fetch
            const data = await fetcher(signal)
            if (cacheObj.key) {
                await writeCache(cacheObj.key, data, cacheObj.store)
            }
            return data
        }
    }

    useEffect(() => {
        const startTime = currentTimestamp()
        const isReady = readyFn?.(waitableVal as W) ?? true

        // If hideReload=false or current is not loaded, revert to 'loading'
        if (!hideReload || !hasLoaded(value)) {
            setValue(loading, startTime)
        }

        if (isReady && actualFetcher) {
            abortControllerRef.current = new AbortController()
            const signal = abortControllerRef.current.signal

            // Try read from cache first (if key)
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
                    if (
                        currentlyLoading.size === 0 &&
                        typeof window !== "undefined" &&
                        "prerenderReady" in window
                    ) {
                        ;(window as any).prerenderReady = true
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
        ...deps,
    ])

    const cleanupFunc = useCallback(() => {
        abortControllerRef.current?.abort()
    }, [])

    return [value, cleanupFunc]
}
