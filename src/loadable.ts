import {
    DependencyList,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react"

/**
 * Represents an integer timestamp (e.g. milliseconds since epoch or any monotonic count).
 *
 * @public
 */
export type TimeStamp = number

/**
 * Returns the current time as a `TimeStamp`.
 *
 * @remarks
 * By default, this is just `Date.now()`. You can replace this with a custom
 * monotonic clock or high-resolution timer if desired.
 *
 * @returns The current time in milliseconds.
 *
 * @example
 * ```ts
 * const now = currentTimestamp()
 * console.log("The time is", now)
 * ```
 *
 * @public
 */
export function currentTimestamp(): TimeStamp {
    return Date.now()
}

/**
 * Provides a stable function that, when called, creates (or re-creates)
 * an `AbortController` and returns its `signal`.
 *
 * @remarks
 * Each render, the same function reference is returned. Calling it effectively
 * aborts any in-flight request and starts a fresh `AbortController`.
 *
 * @returns A function which, when called, returns a fresh `AbortSignal`.
 *
 * @example
 * ```ts
 * function MyComponent() {
 *   const createAbortSignal = useAbort()
 *
 *   useEffect(() => {
 *     const signal = createAbortSignal()
 *     fetch('/api', { signal }).catch(e => { ... })
 *   }, [])
 *   ...
 * }
 * ```
 *
 * @public
 */
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

// -------------------------------------------------------------------
// Loading Symbol + LoadingToken
// -------------------------------------------------------------------

/**
 * A class-based token to represent a unique "loading" state instance.
 *
 * @remarks
 * Using a `LoadingToken` instead of the default `loading` symbol allows you
 * to store additional metadata—e.g., timestamps, request IDs, etc. This can
 * facilitate debugging or concurrency strategies that rely on distinct tokens.
 *
 * @example
 * ```ts
 * import { LoadingToken } from "./useLoadable"
 *
 * const token = new LoadingToken()
 * console.log("Loading started at:", token.startTime)
 * ```
 *
 * @public
 */
export class LoadingToken {
    /**
     * Creates a new `LoadingToken`.
     *
     * @param startTime - When this token was created. Defaults to currentTimestamp().
     */
    constructor(
        public readonly startTime: TimeStamp = currentTimestamp()
    ) {}
}

/**
 * A unique symbol representing a "loading" state.
 *
 * @remarks
 * This symbol is used by default in loadable data when an async request is in-flight.
 * Using a symbol is a simple approach for representing loading without additional metadata.
 *
 * @public
 */
export const loading: unique symbol = Symbol("loading")

/**
 * A union type that can be either the default `loading` symbol or a class-based `LoadingToken`.
 *
 * @public
 */
export type Loading = typeof loading | LoadingToken

/**
 * Checks if the given value represents a "loading" state.
 *
 * @param value - The value to check.
 * @returns True if it’s either `loading` (symbol) or an instance of `LoadingToken`.
 *
 * @example
 * ```ts
 * if (isLoadingValue(loadable)) {
 *   return <Spinner />
 * }
 * ```
 *
 * @public
 */
export function isLoadingValue(value: unknown): value is Loading {
    return value === loading || value instanceof LoadingToken
}

// -------------------------------------------------------------------
// Error for load failures
// -------------------------------------------------------------------

/**
 * Represents an error that occurred while loading or fetching data.
 *
 * @remarks
 * Wraps the original `cause` and optionally overrides the error message.
 *
 * @example
 * ```ts
 * // If a fetch fails, we might return a LoadError instead of a generic Error.
 * throw new LoadError(err, "Failed to load user info")
 * ```
 *
 * @public
 */
export class LoadError extends Error {
    /**
     * Creates a new `LoadError`.
     *
     * @param cause - The underlying reason for the load failure (e.g., an Error object).
     * @param message - An optional descriptive message. Defaults to the cause’s message.
     */
    constructor(public readonly cause: unknown, message?: string) {
        super(
            message ?? (cause instanceof Error ? cause.message : String(cause))
        )
    }
}

// -------------------------------------------------------------------
// Loadable types
// -------------------------------------------------------------------

/**
 * A union type that can be either a "start" (e.g., `loading`) or a "result" (success or failure).
 *
 * @remarks
 * - `Start` usually represents a `Loading` state.
 * - `Result` can be the successful data type `T` or `LoadError`.
 *
 * @public
 */
export type Reaction<Start, Result> = Start | Result

/**
 * A `Loadable<T>` can be:
 * - `loading` or `LoadingToken` (in-flight),
 * - a loaded value of type `T`, or
 * - a `LoadError` (failed).
 *
 * @public
 */
export type Loadable<T> = Reaction<Loading, T | LoadError>

/**
 * Extracts the loaded type from a `Loadable<T>`, excluding `loading` or `LoadError`.
 *
 * @public
 */
export type Loaded<T> = Exclude<T, Loading | LoadError>

/**
 * Checks if a `Loadable<T>` has fully loaded (i.e., is neither loading nor an error).
 *
 * @param loadable - The loadable value to check.
 * @returns True if it’s the successful data of type `T`.
 *
 * @public
 */
export function hasLoaded<T>(loadable: Loadable<T>): loadable is Loaded<T> {
    return !isLoadingValue(loadable) && !loadFailed(loadable)
}

/**
 * Checks if a `Loadable<T>` is a load failure (`LoadError`).
 *
 * @param loadable - The loadable value to check.
 * @returns True if it’s a `LoadError`.
 *
 * @public
 */
export function loadFailed<T>(loadable: Loadable<T>): loadable is LoadError {
    return loadable instanceof LoadError
}

/**
 * Applies a mapper function to a loadable if it’s successfully loaded, returning a new loadable.
 *
 * @remarks
 * If `loadable` is an error or loading, it’s returned unchanged.
 *
 * @param loadable - The original loadable.
 * @param mapper - A function that transforms the loaded data `T` into `R`.
 * @returns A new loadable with data of type `R`, or the same loading/error state.
 *
 * @public
 */
export function map<T, R>(loadable: Loadable<T>, mapper: (loaded: T) => R): Loadable<R> {
    if (loadFailed(loadable)) return loadable
    if (isLoadingValue(loadable)) return loadable
    return mapper(loadable)
}

/**
 * Combines multiple loadables into one. If any are still loading or have failed, returns `loading`.
 *
 * @remarks
 * In reality, `all()` returns `loading` if ANY have not loaded. If all are loaded, it returns an array
 * of their loaded values (typed to match each item in `loadables`).
 *
 * @param loadables - The loadable values to combine.
 * @returns A single loadable that is `loading` if any item is not loaded, else an array of loaded items.
 *
 * @example
 * ```ts
 * const combined = all(userLoadable, postsLoadable, statsLoadable)
 * if (!hasLoaded(combined)) {
 *   return <Spinner />
 * }
 * const [user, posts, stats] = combined
 * ```
 *
 * @public
 */
export function all<T extends Loadable<unknown>[]>(...loadables: T): Loadable<{ [K in keyof T]: Loaded<T[K]> }> {
    if (loadables.some(l => !hasLoaded(l))) {
        return loading
    }
    return loadables.map(l => l) as { [K in keyof T]: Loaded<T[K]> }
}

/**
 * Converts a loadable to `undefined` if not fully loaded, or the loaded value otherwise.
 *
 * @param loadable - The loadable value to unwrap.
 * @returns `T` if loaded, otherwise `undefined`.
 *
 * @public
 */
export function toOptional<T>(loadable: Loadable<T>): T | undefined {
    return hasLoaded(loadable) ? loadable : undefined
}

/**
 * Returns the loaded value if `loadable` is fully loaded, otherwise `defaultValue`.
 *
 * @param loadable - The loadable value to unwrap.
 * @param defaultValue - The fallback if loadable is not loaded.
 * @returns The loaded `T` or the provided `defaultValue`.
 *
 * @public
 */
export function orElse<T, R>(loadable: Loadable<T>, defaultValue: R): T | R {
    return hasLoaded(loadable) ? loadable : defaultValue
}

/**
 * Checks if a loadable is fully loaded AND not null/undefined.
 *
 * @param loadable - A loadable that could be `null` or `undefined` once loaded.
 * @returns True if the loadable is successfully loaded and non-nullish.
 *
 * @public
 */
export function isUsable<T>(loadable: Loadable<T | null | undefined>): loadable is T {
    return hasLoaded(loadable) && loadable != null
}

// -------------------------------------------------------------------
// Basic fetcher type
// -------------------------------------------------------------------

/**
 * A function type that fetches data and returns a promise, using an `AbortSignal`.
 *
 * @param signal - The `AbortSignal` to handle cancellations.
 * @returns A promise resolving to the fetched data of type `T`.
 *
 * @public
 */
export type Fetcher<T> = (signal: AbortSignal) => Promise<T>

// -------------------------------------------------------------------
// Caching shapes
// -------------------------------------------------------------------

/**
 * Defines the shape of a cache option with a key and an optional store.
 *
 * @public
 */
export interface CacheOption {
    /**
     * The key to store in the cache (e.g., "myUserData").
     */
    key: string
    /**
     * The store used for caching. Defaults to `"localStorage"`.
     */
    store?: "memory" | "localStorage" | "indexedDB"
}

/**
 * Parses a `cache` field that could be a string or an object, returning a normalized object.
 *
 * @param cache - Either a string or `{ key, store }`.
 * @returns An object with `key` and `store`.
 *
 * @internal
 */
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

// -------------------------------------------------------------------
// Our caching utilities
// -------------------------------------------------------------------

/** @internal */
const memoryCache = new Map<string, unknown>()

/**
 * Reads data from the specified cache store.
 *
 * @internal
 * @param key - The cache key.
 * @param store - Which store to use ("memory", "localStorage", or "indexedDB").
 * @returns The cached data or `undefined` if not found.
 */
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

/**
 * Writes data to the specified cache store.
 *
 * @internal
 * @param key - The cache key.
 * @param data - The data to store.
 * @param store - The store to use.
 */
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

/**
 * Opens (and initializes) an IndexedDB database named "myReactCacheDB" with an object store "idbCache".
 *
 * @internal
 * @returns A promise resolving to the opened IDBDatabase.
 */
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

/**
 * Reads an item from the "idbCache" store in our "myReactCacheDB" IndexedDB.
 *
 * @internal
 */
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

/**
 * Writes an item to the "idbCache" store in our "myReactCacheDB" IndexedDB.
 *
 * @internal
 */
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

// -------------------------------------------------------------------
// Options for useLoadable
// -------------------------------------------------------------------

/**
 * The options object for `useLoadable`.
 *
 * @typeParam T - The data type we expect to load.
 *
 * @public
 */
export interface UseLoadableOptions<T = any> {
    /**
     * A prefetched loadable value, if available (used instead of calling the fetcher).
     */
    prefetched?: Loadable<T>
    /**
     * An optional callback for load errors. Called with the raw error object.
     */
    onError?: (error: unknown) => void
    /**
     * If true, once we have a loaded value, do **not** revert to `loading`
     * on subsequent fetches; instead, keep the old value until the new fetch
     * finishes or fails.
     */
    hideReload?: boolean
    /**
     * Caching configuration. Can be:
     * - A string: used as the cache key (store defaults to `"localStorage"`).
     * - An object: `{ key: string, store?: "memory" | "localStorage" | "indexedDB" }`.
     */
    cache?: string | CacheOption
}

// -------------------------------------------------------------------
// A custom hook for state with timestamps
// -------------------------------------------------------------------

/**
 * A hook that manages a piece of state (`T`) alongside a timestamp, allowing you
 * to ignore stale updates with older timestamps.
 *
 * @remarks
 * Internally, it stores the current `value` plus a `loadStart` timestamp. Each time
 * you set a new value, you can provide an optional new timestamp. If that timestamp
 * is older than the current state's `loadStart`, the update is ignored.
 *
 * @param initial - The initial state value.
 * @returns A tuple: `[value, setValue, loadStart]`.
 *
 * @example
 * ```ts
 * const [myValue, setMyValue, lastUpdated] = useLatestState(0)
 *
 * function handleUpdate(newVal: number) {
 *   // We'll pass a timestamp
 *   setMyValue(newVal, performance.now())
 * }
 * ```
 *
 * @public
 */
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

// -------------------------------------------------------------------
// For debugging (optional)
// -------------------------------------------------------------------

/**
 * A Set of timestamps indicating which requests are currently in-flight.
 *
 * @remarks
 * This is used internally for debugging and to signal "prerenderReady" when no requests remain.
 * Attach it to `window` in dev environments if desired.
 *
 * @internal
 */
const currentlyLoading = new Set<number>()
// @ts-ignore
if (typeof window !== "undefined") {
    ;(window as any).currentlyLoading = currentlyLoading
}

// -------------------------------------------------------------------
// Overloads for useLoadable
// -------------------------------------------------------------------

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
 * The core hook that returns a `Loadable<T>` by calling an async fetcher.
 *
 * @remarks
 * Has two main usage patterns:
 * 1. **Waitable** form: You pass a "waitable" value plus a `readyCondition`, and a `fetcher`.
 *    - The effect only runs when `readyCondition(waitable)` is true.
 *    - If `hideReload` is false, it will revert to loading each time the waitable changes.
 *
 * 2. **Simple** form: You pass just a `fetcher`, dependencies, and optional `UseLoadableOptions`.
 *    - The fetcher is called whenever dependencies change.
 *    - The result is stored in a loadable: `loading` until success or `LoadError` on failure.
 *
 * Caching:
 * - If `cache` is provided (string or `{ key, store }`), it tries to read from that cache first.
 *   If found, returns it immediately. Then (optionally) re-fetches in the background, or
 *   according to `hideReload`.
 *
 * @typeParam T - The successful data type when using the simple form.
 * @typeParam W - The waitable type (for advanced usage).
 * @typeParam R - The successful data type when using the waitable form.
 *
 * @public
 */
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

// -------------------------------------------------------------------
// useThen + useAllThen
// -------------------------------------------------------------------

/**
 * A hook that waits for a `loadable` to finish, then calls another async `fetcher`.
 *
 * @remarks
 * If `loadable` is still loading or has failed, this hook returns the same `loadable` state.
 * Otherwise, if `loadable` is loaded, it calls `fetcher(loadedValue)` and returns the result
 * as a new `Loadable<R>`.
 *
 * @param loadable - The initial loadable value.
 * @param fetcher - A function that takes the successfully loaded data plus an abort signal, returning a promise.
 * @param dependencies - An optional list of dependencies to trigger re-runs. Defaults to `[hasLoaded(loadable)]`.
 * @param options - Optional `UseLoadableOptions` for error handling, caching, etc.
 * @returns A `Loadable<R>` that is `loading` until the chained fetch finishes, or a `LoadError` if it fails.
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
    )
}

/** @internal */
type UnwrapLoadable<T> = T extends Loadable<infer U> ? U : never
/** @internal */
type LoadableParameters<T extends Loadable<any>[]> = {
    [K in keyof T]: UnwrapLoadable<T[K]>
}

/**
 * A hook that waits for multiple loadables to finish, then calls a `fetcher` using all their loaded values.
 *
 * @remarks
 * Internally, it calls `all(...loadables)`. If any loadable is still loading or fails, the combined is `loading`.
 * Once all are loaded, calls `fetcher(...loadedValues, signal)` and returns a `Loadable<R>`.
 *
 * @param loadables - An array (spread) of loadable values, e.g. `[user, stats, posts]`.
 * @param fetcher - A function that takes each loaded value plus an `AbortSignal`.
 * @param dependencies - An optional list of dependencies to re-run the effect. Defaults to the loadables array.
 * @param options - Optional config for error handling, caching, etc.
 * @returns A loadable result of type `R`.
 *
 * @example
 * ```ts
 * const user = useLoadable(fetchUser, [])
 * const stats = useLoadable(fetchStats, [])
 *
 * const combined = useAllThen(
 *   [user, stats],
 *   (u, s, signal) => fetchDashboard(u, s, signal),
 *   []
 * )
 * ```
 *
 * @public
 */
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

// -------------------------------------------------------------------
// useLoadableWithCleanup
// -------------------------------------------------------------------

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
 * A variant of `useLoadable` that returns a `[Loadable<T>, cleanupFunc]` tuple.
 *
 * @remarks
 * This lets you manually call `cleanupFunc()` to abort any in-flight request,
 * instead of waiting for an unmount or effect re-run.
 *
 * @returns A tuple: `[Loadable<T>, cleanupFunc]`.
 *
 * @example
 * ```ts
 * const [userLoadable, cleanup] = useLoadableWithCleanup(fetchUser, [])
 *
 * // Manually abort the current fetch:
 * cleanup()
 * ```
 *
 * @public
 */
export function useLoadableWithCleanup<T, W, R>(
    fetcherOrWaitable: Fetcher<T> | W,
    depsOrReadyCondition: DependencyList | ((loaded: W) => boolean),
    optionsOrFetcher?:
        | UseLoadableOptions<T>
        | ((loaded: W, abort: AbortSignal) => Promise<R>),
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

        // The actual fetcher that either reads from cache or calls the original fetcher
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

    /**
     * Cancels any current request immediately. This is the second element
     * in the returned tuple from `useLoadableWithCleanup`.
     */
    const cleanupFunc = useCallback(() => {
        abortControllerRef.current?.abort()
    }, [])

    return [value, cleanupFunc]
}