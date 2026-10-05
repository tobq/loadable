// The Loadable union, its two markers, and the pure helpers over it. No React in this file.

/**
 * Represents an integer timestamp (milliseconds since epoch).
 *
 * @public
 */
export type TimeStamp = number

/**
 * Returns the current wall-clock time as a `TimeStamp` (`Date.now()`).
 *
 * @remarks
 * Used for {@link LoadingToken.startTime}, which says when a wait began (so a UI can tell a wait too
 * short to notice from one that is not). It is NOT used to order requests: two requests can start
 * in the same millisecond, so the hooks order them by a counter instead.
 *
 * @public
 */
export function currentTimestamp(): TimeStamp {
    return Date.now()
}

// -------------------------------------------------------------------
// Brands
// -------------------------------------------------------------------

// Registered symbols, so two copies of this library in one app (an ESM and a CJS build, or two
// versions in a monorepo) still recognise each other's markers. `instanceof` is routed through
// these brands by `Symbol.hasInstance` below.
const LOADING_TOKEN_BRAND: unique symbol = Symbol.for("@tobq/loadable/LoadingToken")
const LOAD_ERROR_BRAND: unique symbol = Symbol.for("@tobq/loadable/LoadError")

function hasBrand(value: unknown, brand: symbol): boolean {
    return (
        value != null &&
        (typeof value === "object" || typeof value === "function") &&
        (value as Record<symbol, unknown>)[brand] === true
    )
}

/**
 * Carries the last good value into a marker. `previous` may legitimately be `undefined` (a loaded
 * value can be `undefined`), which is why markers record `hasPrevious` separately.
 *
 * @public
 */
export interface WithPrevious<T> {
    previous: T
}

// -------------------------------------------------------------------
// Loading
// -------------------------------------------------------------------

/**
 * A "loading" marker that carries metadata: when the wait began and, for a reload, the value it
 * is replacing.
 *
 * @remarks
 * The plain {@link loading} symbol means "nothing to show yet". A `LoadingToken` with
 * `hasPrevious` means "a newer value is on its way; here is the one it replaces", which lets a UI
 * keep the old value on screen (dimmed) instead of collapsing to a skeleton. Read it with
 * {@link latest}.
 *
 * @example
 * ```ts
 * const token = new LoadingToken(Date.now(), { previous: lastRows })
 * latest(token) // lastRows
 * ```
 *
 * @public
 */
export class LoadingToken<T = unknown> {
    /** @internal */
    readonly [LOADING_TOKEN_BRAND] = true as const
    /** The value being replaced, when {@link LoadingToken.hasPrevious} is true. Prefer {@link latest}. */
    readonly previous: T | undefined
    /** Whether this token carries a previous value (which may itself be `undefined`). */
    readonly hasPrevious: boolean

    /**
     * @param startTime - When the wait began. Defaults to {@link currentTimestamp}.
     * @param options - `{ previous }` when this load replaces a value that can stay on screen.
     */
    constructor(
        public readonly startTime: TimeStamp = currentTimestamp(),
        options?: WithPrevious<T>
    ) {
        this.hasPrevious = options !== undefined && "previous" in options
        this.previous = options?.previous
    }

    /** @internal Brand-based so a token from another copy of this library still matches. */
    static [Symbol.hasInstance](value: unknown): boolean {
        if (this !== LoadingToken) return Function.prototype[Symbol.hasInstance].call(this, value)
        return hasBrand(value, LOADING_TOKEN_BRAND)
    }
}

/**
 * The "nothing to show yet" marker.
 *
 * @remarks
 * Registered with `Symbol.for`, so it is the same symbol in every copy of this library. Hooks
 * return it whenever there is no previous value to keep showing, which keeps `x === loading`
 * checks working.
 *
 * @public
 */
export const loading: unique symbol = Symbol.for("@tobq/loadable/loading")

/**
 * Either loading marker: the bare {@link loading} symbol or a {@link LoadingToken}.
 *
 * @public
 */
export type Loading = typeof loading | LoadingToken

/**
 * Checks if the given value represents a "loading" state.
 *
 * @param value - The value to check.
 * @returns True if it is either `loading` (symbol) or a `LoadingToken`.
 *
 * @public
 */
export function isLoadingValue(value: unknown): value is Loading {
    return value === loading || value instanceof LoadingToken
}

// -------------------------------------------------------------------
// Failure
// -------------------------------------------------------------------

/**
 * Represents a failed load.
 *
 * @remarks
 * Wraps the original `cause`. When a reload or background refresh fails after a good value was
 * already shown, the error carries that value as `previous` (read it with {@link latest}), so a
 * UI can keep the data on screen, marked stale, next to a retry.
 *
 * @example
 * ```ts
 * new LoadError(err, "Failed to load user info")
 * new LoadError(err, undefined, { previous: lastUser })
 * ```
 *
 * @public
 */
export class LoadError<T = unknown> extends Error {
    /** @internal */
    readonly [LOAD_ERROR_BRAND] = true as const
    /** The last good value, when {@link LoadError.hasPrevious} is true. Prefer {@link latest}. */
    readonly previous: T | undefined
    /** Whether this error carries a previous value (which may itself be `undefined`). */
    readonly hasPrevious: boolean

    /**
     * @param cause - The underlying reason for the failure.
     * @param message - A descriptive message. Defaults to the cause's message.
     * @param options - `{ previous }` when a good value was already on screen.
     */
    constructor(public readonly cause: unknown, message?: string, options?: WithPrevious<T>) {
        super(message ?? (cause instanceof Error ? cause.message : String(cause)))
        this.hasPrevious = options !== undefined && "previous" in options
        this.previous = options?.previous
    }

    /** @internal Brand-based so an error from another copy of this library still matches. */
    static [Symbol.hasInstance](value: unknown): boolean {
        if (this !== LoadError) return Function.prototype[Symbol.hasInstance].call(this, value)
        return hasBrand(value, LOAD_ERROR_BRAND)
    }
}

/**
 * Normalises anything thrown by a fetcher into a `LoadError`, optionally carrying the last good
 * value. A `LoadError` thrown on purpose keeps its cause and message instead of being wrapped twice.
 *
 * @internal
 */
export function toLoadError<T>(error: unknown, good?: { value: T }): LoadError<T> {
    if (error instanceof LoadError) {
        if (!good || error.hasPrevious) return error as LoadError<T>
        return new LoadError<T>(error.cause, error.message, { previous: good.value })
    }
    return new LoadError<T>(error, undefined, good ? { previous: good.value } : undefined)
}

// -------------------------------------------------------------------
// Loadable
// -------------------------------------------------------------------

/**
 * A union type that can be either a "start" (e.g., `loading`) or a "result" (success or failure).
 *
 * @public
 */
export type Reaction<Start, Result> = Start | Result

/**
 * A `Loadable<T>` is one of:
 * - `loading`: nothing to show yet;
 * - a `LoadingToken`: loading, possibly carrying the value it replaces;
 * - `T`: loaded;
 * - a `LoadError`: failed, possibly carrying the last good value.
 *
 * @remarks
 * The markers are deliberately untyped inside the union (their `previous` is `unknown` there), so
 * a `Loadable<A>` stays assignable wherever `A` is, exactly as in 2.0. Read a carried value with
 * {@link latest}, which types it as `T`.
 *
 * @public
 */
export type Loadable<T> = Reaction<Loading, T | LoadError>

/**
 * Extracts the loaded type from a `Loadable<T>`, excluding the loading and failure markers.
 *
 * @public
 */
export type Loaded<T> = Exclude<T, Loading | LoadError>

/**
 * Checks if a `Loadable<T>` has fully loaded (i.e., is neither loading nor an error).
 *
 * @public
 */
export function hasLoaded<T>(loadable: Loadable<T>): loadable is Loaded<T> {
    return !isLoadingValue(loadable) && !loadFailed(loadable)
}

/**
 * Checks if a `Loadable<T>` is a load failure (`LoadError`).
 *
 * @public
 */
export function loadFailed<T>(loadable: Loadable<T>): loadable is LoadError {
    return loadable instanceof LoadError
}

/**
 * The value to show right now: the loaded value, or the previous value a loading or failed marker
 * carries, or `undefined` when there is nothing to show.
 *
 * @example
 * ```tsx
 * const [rows] = useLoadableQuery(fetchRows, [filter])
 * const shown = latest(rows) // stays on screen while the next filter loads
 * ```
 *
 * @public
 */
export function latest<T>(loadable: Loadable<T>): T | undefined {
    if (loadable === loading) return undefined
    if (loadable instanceof LoadingToken || loadable instanceof LoadError) {
        return loadable.hasPrevious ? (loadable.previous as T) : undefined
    }
    return loadable as T
}

/**
 * Applies a mapper to a loaded value, returning a new loadable.
 *
 * @remarks
 * Loading and failed states pass through. When they carry a previous value, the mapper is applied
 * to that too, so a derived view keeps showing its previous result during a reload.
 *
 * @public
 */
export function map<T, R>(loadable: Loadable<T>, mapper: (loaded: T) => R): Loadable<R> {
    if (loadable === loading) return loading
    if (loadable instanceof LoadingToken) {
        if (!loadable.hasPrevious) return loadable
        return new LoadingToken<R>(loadable.startTime, { previous: mapper(loadable.previous as T) })
    }
    if (loadable instanceof LoadError) {
        if (!loadable.hasPrevious) return loadable
        return new LoadError<R>(loadable.cause, loadable.message, {
            previous: mapper(loadable.previous as T),
        })
    }
    return mapper(loadable as T)
}

/**
 * Combines multiple loadables into one. If any is still loading or has failed, returns `loading`;
 * otherwise an array of their loaded values.
 *
 * @example
 * ```ts
 * const combined = all(userLoadable, postsLoadable)
 * if (!hasLoaded(combined)) return <Spinner />
 * const [user, posts] = combined
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
 * @public
 */
export function toOptional<T>(loadable: Loadable<T>): T | undefined {
    return hasLoaded(loadable) ? loadable : undefined
}

/**
 * Returns the loaded value if `loadable` is fully loaded, otherwise `defaultValue`.
 *
 * @public
 */
export function orElse<T, R>(loadable: Loadable<T>, defaultValue: R): T | R {
    return hasLoaded(loadable) ? loadable : defaultValue
}

/**
 * Checks if a loadable is fully loaded AND not null/undefined.
 *
 * @public
 */
export function isUsable<T>(loadable: Loadable<T | null | undefined>): loadable is T {
    return hasLoaded(loadable) && loadable != null
}

/**
 * A function that fetches data, honouring an `AbortSignal`.
 *
 * @public
 */
export type Fetcher<T> = (signal: AbortSignal) => Promise<T>

// -------------------------------------------------------------------
// Request bookkeeping shared by every hook
// -------------------------------------------------------------------

let lastRequestId = 0

/**
 * A process-wide, strictly increasing request id. Orders results instead of timestamps, which tie
 * when two requests start in the same millisecond.
 *
 * @internal
 */
export function nextRequestId(): number {
    return ++lastRequestId
}

/**
 * The ids of requests currently in flight.
 *
 * @remarks
 * Exposed as `window.currentlyLoading` for debugging. When it empties after a request settles and
 * the page defines `window.prerenderReady`, that flag is set to `true` (the prerender contract).
 *
 * @internal
 */
const currentlyLoading = new Set<number>()
if (typeof window !== "undefined") {
    ;(window as unknown as { currentlyLoading: Set<number> }).currentlyLoading = currentlyLoading
}

/** @internal */
export function beginRequest(id: number): void {
    currentlyLoading.add(id)
}

/** @internal Called when a request is abandoned (effect cleanup); does not signal readiness. */
export function forgetRequest(id: number): void {
    currentlyLoading.delete(id)
}

/** @internal Called when a request settles, whatever the outcome. */
export function settleRequest(id: number): void {
    currentlyLoading.delete(id)
    if (currentlyLoading.size === 0 && typeof window !== "undefined" && "prerenderReady" in window) {
        ;(window as unknown as { prerenderReady: boolean }).prerenderReady = true
    }
}

/**
 * Calls a caller's `onError` without letting a bug in it wedge the hook.
 *
 * @internal
 */
export function reportError(onError: ((error: unknown) => void) | undefined, error: unknown): void {
    if (!onError) return
    try {
        onError(error)
    } catch (handlerError) {
        console.error("@tobq/loadable: onError threw", handlerError)
    }
}

/**
 * Starts a fetcher, turning a synchronous throw into a rejected promise.
 *
 * @internal
 */
export function invoke<T>(run: () => PromiseLike<T> | T): Promise<T> {
    try {
        return Promise.resolve(run())
    } catch (error) {
        return Promise.reject(error)
    }
}

/**
 * Element-wise `Object.is` comparison, the same rule React applies to dependency lists.
 *
 * @internal
 */
export function sameDeps(a: readonly unknown[] | undefined, b: readonly unknown[]): boolean {
    if (!a || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (!Object.is(a[i], b[i])) return false
    }
    return true
}
