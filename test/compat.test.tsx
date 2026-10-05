// Pins the 2.0.x behaviour that existing callers rely on. Written BEFORE the 2.1 refactor and run
// against the old implementation first: anything here changing is a breaking change.
import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    all,
    hasLoaded,
    isLoadingValue,
    isUsable,
    loadFailed,
    LoadError,
    loading,
    LoadingToken,
    map,
    orElse,
    toOptional,
    useAllThen,
    useLoadable,
    useThen,
    type Loadable,
} from "../src"
import { controlledFetcher, deferred, flush } from "./helpers"

afterEach(() => {
    vi.restoreAllMocks()
})

describe("helpers", () => {
    it("narrow the three states", () => {
        const err = new LoadError(new Error("boom"))
        expect(hasLoaded(1)).toBe(true)
        expect(hasLoaded(loading)).toBe(false)
        expect(hasLoaded(new LoadingToken())).toBe(false)
        expect(hasLoaded(err)).toBe(false)
        expect(loadFailed(err)).toBe(true)
        expect(loadFailed(1)).toBe(false)
        expect(isLoadingValue(loading)).toBe(true)
        expect(isLoadingValue(new LoadingToken())).toBe(true)
        expect(isLoadingValue(null)).toBe(false)
    })

    it("map, all, toOptional, orElse and isUsable", () => {
        const err = new LoadError("nope")
        expect(map(2, v => v * 3)).toBe(6)
        expect(map(loading as Loadable<number>, v => v * 3)).toBe(loading)
        expect(map(err as Loadable<number>, v => v * 3)).toBe(err)
        expect(all(1, "a")).toEqual([1, "a"])
        expect(all(1, loading)).toBe(loading)
        expect(all(1, err)).toBe(loading)
        expect(toOptional(5)).toBe(5)
        expect(toOptional(loading)).toBeUndefined()
        expect(orElse(loading, "fallback")).toBe("fallback")
        expect(orElse(3, "fallback")).toBe(3)
        expect(isUsable(null)).toBe(false)
        expect(isUsable(loading)).toBe(false)
        expect(isUsable(0)).toBe(true)
    })

    it("LoadError is an Error carrying its cause and message", () => {
        const cause = new Error("inner")
        const err = new LoadError(cause)
        expect(err).toBeInstanceOf(Error)
        expect(err.cause).toBe(cause)
        expect(err.message).toBe("inner")
        expect(new LoadError("text").message).toBe("text")
        expect(new LoadError(cause, "outer").message).toBe("outer")
    })

    it("LoadingToken records when it started", () => {
        vi.spyOn(Date, "now").mockReturnValue(1234)
        expect(new LoadingToken().startTime).toBe(1234)
        expect(new LoadingToken(99).startTime).toBe(99)
    })
})

describe("useLoadable", () => {
    it("is the bare loading symbol first, then the value", async () => {
        const { fetcher, calls } = controlledFetcher<number>()
        const { result } = renderHook(() => useLoadable(fetcher, []))
        expect(result.current).toBe(loading)
        await act(async () => calls[0].deferred.resolve(7))
        expect(result.current).toBe(7)
    })

    it("turns a rejection into a LoadError and reports the raw error", async () => {
        const onError = vi.fn()
        const { fetcher, calls } = controlledFetcher<number>()
        const { result } = renderHook(() => useLoadable(fetcher, [], { onError }))
        const cause = new Error("down")
        await act(async () => calls[0].deferred.reject(cause))
        expect(loadFailed(result.current)).toBe(true)
        expect((result.current as LoadError).cause).toBe(cause)
        expect(onError).toHaveBeenCalledWith(cause)
    })

    it("resets to loading when deps change and aborts the old request", async () => {
        const { fetcher, calls } = controlledFetcher<string>()
        const { result, rerender } = renderHook(({ id }) => useLoadable(fetcher, [id]), {
            initialProps: { id: 1 },
        })
        await act(async () => calls[0].deferred.resolve("one"))
        expect(result.current).toBe("one")
        rerender({ id: 2 })
        expect(result.current).toBe(loading)
        expect(calls).toHaveLength(2)
        await act(async () => calls[1].deferred.resolve("two"))
        expect(result.current).toBe("two")
    })

    it("lets the newest request win when an older one settles late", async () => {
        const fetches = [deferred<string>(), deferred<string>()]
        let n = 0
        const { result, rerender } = renderHook(
            ({ id }) => useLoadable(() => fetches[n++].promise, [id]),
            { initialProps: { id: 1 } },
        )
        rerender({ id: 2 })
        await act(async () => fetches[1].resolve("new"))
        await act(async () => fetches[0].resolve("old"))
        expect(result.current).toBe("new")
    })

    it("with hideReload keeps the last value while the next one loads", async () => {
        const { fetcher, calls } = controlledFetcher<string>()
        const { result, rerender } = renderHook(
            ({ id }) => useLoadable(fetcher, [id], { hideReload: true }),
            { initialProps: { id: 1 } },
        )
        expect(result.current).toBe(loading)
        await act(async () => calls[0].deferred.resolve("one"))
        rerender({ id: 2 })
        expect(result.current).toBe("one")
        await act(async () => calls[1].deferred.resolve("two"))
        expect(result.current).toBe("two")
    })

    it("returns a prefetched value without calling the fetcher", async () => {
        const fetcher = vi.fn(async () => 1)
        const { result } = renderHook(() => useLoadable(fetcher, [], { prefetched: 42 }))
        await flush()
        expect(result.current).toBe(42)
        expect(fetcher).not.toHaveBeenCalled()
    })

    it("fetches when the prefetched value is still loading", async () => {
        const fetcher = vi.fn(async () => 1)
        const { result } = renderHook(() => useLoadable(fetcher, [], { prefetched: loading }))
        await flush()
        expect(result.current).toBe(1)
        expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it("stores an array-wrapped function as a value", async () => {
        const fn = () => "called"
        const { result } = renderHook(() => useLoadable(async () => [fn] as const, []))
        await flush()
        expect((result.current as readonly [() => string])[0]).toBe(fn)
    })

    it("waitable form waits for the ready condition", async () => {
        const fetcher = vi.fn(async (w: number) => w * 2)
        const { result, rerender } = renderHook(
            ({ w }) => useLoadable(w, v => v > 0, fetcher, [w]),
            { initialProps: { w: 0 } },
        )
        await flush()
        expect(result.current).toBe(loading)
        expect(fetcher).not.toHaveBeenCalled()
        rerender({ w: 4 })
        await flush()
        expect(result.current).toBe(8)
    })

    it("marks prerenderReady once nothing is loading", async () => {
        const w = window as unknown as { prerenderReady?: boolean }
        w.prerenderReady = false
        const { fetcher, calls } = controlledFetcher<number>()
        renderHook(() => useLoadable(fetcher, []))
        expect(w.prerenderReady).toBe(false)
        await act(async () => calls[0].deferred.resolve(1))
        expect(w.prerenderReady).toBe(true)
        delete w.prerenderReady
    })
})

describe("useThen / useAllThen", () => {
    it("chains on the loaded value", async () => {
        const first = controlledFetcher<number>()
        const then = vi.fn(async (v: number) => v + 1)
        const { result } = renderHook(() => {
            const a = useLoadable(first.fetcher, [])
            return useThen(a, then)
        })
        expect(result.current).toBe(loading)
        await act(async () => first.calls[0].deferred.resolve(1))
        await flush()
        expect(result.current).toBe(2)
        expect(then).toHaveBeenCalledTimes(1)
    })

    it("reads as loading while the upstream has failed", async () => {
        const then = vi.fn(async (v: number) => v)
        const { result } = renderHook(() => useThen(new LoadError("x") as Loadable<number>, then))
        await flush()
        expect(result.current).toBe(loading)
        expect(then).not.toHaveBeenCalled()
    })

    it("useAllThen waits for every input", async () => {
        const { result, rerender } = renderHook(
            ({ a, b }: { a: Loadable<number>; b: Loadable<number> }) =>
                useAllThen([a, b], async (x, y) => x + y),
            { initialProps: { a: 1 as Loadable<number>, b: loading as Loadable<number> } },
        )
        await flush()
        expect(result.current).toBe(loading)
        rerender({ a: 1, b: 2 })
        await flush()
        expect(result.current).toBe(3)
    })
})
