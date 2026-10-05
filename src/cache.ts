// The 2.0 caching option. Deprecated: it never revalidates, keys are global, and it cannot tell two
// users or two shapes apart. Kept working (and kept from hanging a hook) until 3.0 removes it.

/**
 * Defines the shape of a cache option with a key and an optional store.
 *
 * @deprecated Caching will be removed in 3.0. Keep data you want across mounts in your own store
 * and pass it as `prefetched`.
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

/** @internal */
export type CacheStore = "memory" | "localStorage" | "indexedDB"

/** @internal */
export interface ParsedCache {
    key?: string
    store: CacheStore
}

/** @internal */
export function parseCacheOption(cache?: string | CacheOption): ParsedCache {
    if (!cache) return { key: undefined, store: "localStorage" }
    if (typeof cache === "string") return { key: cache, store: "localStorage" }
    return { key: cache.key, store: cache.store ?? "localStorage" }
}

const memoryCache = new Map<string, unknown>()

/**
 * Reads a cached value. A store that fails (storage disabled, quota, a broken IndexedDB) reads as a
 * miss, so the hook falls through to its fetcher instead of hanging.
 *
 * @internal
 */
export async function readCache<T>(key: string, store: CacheStore): Promise<T | undefined> {
    try {
        switch (store) {
            case "memory":
                return memoryCache.get(key) as T | undefined
            case "localStorage": {
                const json = window.localStorage.getItem(key)
                if (!json) return undefined
                return JSON.parse(json) as T
            }
            case "indexedDB":
                return await readFromIndexedDB<T>(key)
        }
    } catch (error) {
        console.warn(`@tobq/loadable: cache read failed for "${key}"`, error)
        return undefined
    }
}

/**
 * Writes a cached value. A failed write is logged and ignored: the fetched data is still good.
 *
 * @internal
 */
export async function writeCache<T>(key: string, data: T, store: CacheStore): Promise<void> {
    try {
        switch (store) {
            case "memory":
                memoryCache.set(key, data)
                break
            case "localStorage":
                window.localStorage.setItem(key, JSON.stringify(data))
                break
            case "indexedDB":
                await writeToIndexedDB(key, data)
                break
        }
    } catch (error) {
        console.warn(`@tobq/loadable: cache write failed for "${key}"`, error)
    }
}

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
        const getReq = db.transaction("idbCache", "readonly").objectStore("idbCache").get(key)
        getReq.onsuccess = () => resolve(getReq.result)
        getReq.onerror = () => reject(getReq.error)
    })
}

async function writeToIndexedDB<T>(key: string, data: T): Promise<void> {
    const db = await openCacheDB()
    return new Promise<void>((resolve, reject) => {
        const putReq = db.transaction("idbCache", "readwrite").objectStore("idbCache").put(data, key)
        putReq.onsuccess = () => resolve()
        putReq.onerror = () => reject(putReq.error)
    })
}
