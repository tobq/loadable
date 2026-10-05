// Bugs in the 2.0.x hooks, fixed in 2.1 without changing any behaviour pinned in compat.test.tsx.
import { act, renderHook } from "@testing-library/react"
import { StrictMode, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    hasLoaded,
    isLoadingValue,
    loadFailed,
    LoadError,
    loading,
    LoadingToken,
    useLoadable,
    useLoadableWithCleanup,
} from "../src"
import { controlledFetcher, deferred, flush } from "./helpers"

afterEach(() => {
    vi.restoreAllMocks()
})

describe("2.1 fixes to the existing hooks", () => {
    it("an aborted request never surfaces as a LoadError or reaches onError", async () => {
        const onError = vi.fn()
        const { fetcher, calls } = controlledFetcher<string>()
        const seen: unknown[] = []
        const { result, rerender } = renderHook(
            ({ id }) => {
                const value = useLoadable(fetcher, [id], { hideReload: true, onError })
                seen.push(value)
                return value
            },
            { initialProps: { id: 1 } },
        )
        await act(async () => calls[0].deferred.resolve("one"))
        rerender({ id: 2 }) // request 2 in flight
        rerender({ id: 3 }) // aborts request 2, which rejects with AbortError
        await flush()
        expect(result.current).toBe("one")
        await act(async () => calls[2].deferred.resolve("three"))
        expect(result.current).toBe("three")
        expect(seen.some(v => v instanceof LoadError)).toBe(false)
        expect(onError).not.toHaveBeenCalled()
    })

    it("orders requests correctly even when they start in the same millisecond", async () => {
        vi.spyOn(Date, "now").mockReturnValue(5000)
        const fetches = [deferred<string>(), deferred<string>()]
        let n = 0
        const { result, rerender } = renderHook(
            ({ id }) => useLoadable(() => fetches[n++].promise, [id], { hideReload: true }),
            { initialProps: { id: 1 } },
        )
        rerender({ id: 2 })
        await act(async () => fetches[1].resolve("new"))
        await act(async () => fetches[0].resolve("old"))
        expect(result.current).toBe("new")
    })

    it("an onError that throws still leaves the hook failed, not loading", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        const { fetcher, calls } = controlledFetcher<number>()
        const { result } = renderHook(() =>
            useLoadable(fetcher, [], {
                onError: () => {
                    throw new Error("handler bug")
                },
            }),
        )
        await act(async () => calls[0].deferred.reject(new Error("down")))
        expect(loadFailed(result.current)).toBe(true)
        expect(spy).toHaveBeenCalled()
    })

    it("a fetcher that throws synchronously becomes a LoadError instead of crashing", async () => {
        const { result } = renderHook(() =>
            useLoadable((): Promise<number> => {
                throw new Error("sync")
            }, []),
        )
        await flush()
        expect(loadFailed(result.current)).toBe(true)
        expect((result.current as LoadError).message).toBe("sync")
    })

    it("a prefetched LoadError is returned as-is, not wrapped twice", async () => {
        const prefetched = new LoadError(new Error("server said no"))
        const { result } = renderHook(() => useLoadable(async () => 1, [], { prefetched }))
        await flush()
        expect(result.current).toBe(prefetched)
    })

    it("a fetcher resolving to a function stores the function", async () => {
        const fn = (x: number) => x + 1
        const { result } = renderHook(() => useLoadable(async () => fn, []))
        await flush()
        expect(result.current).toBe(fn)
    })

    it("useLoadableWithCleanup settles instead of re-running every render", async () => {
        const fetcher = vi.fn(async () => "done")
        let renders = 0
        const { result } = renderHook(() => {
            renders++
            return useLoadableWithCleanup(fetcher, [])
        })
        await flush()
        expect(result.current[0]).toBe("done")
        expect(fetcher).toHaveBeenCalledTimes(1)
        expect(renders).toBeLessThan(6)
    })

    it("useLoadableWithCleanup's cleanup aborts the request in flight", async () => {
        const { fetcher, calls } = controlledFetcher<string>()
        const { result } = renderHook(() => useLoadableWithCleanup(fetcher, []))
        act(() => result.current[1]())
        await flush()
        expect(calls[0].signal.aborted).toBe(true)
        expect(loadFailed(result.current[0])).toBe(false)
    })

    it("a broken cache store falls through to the fetcher", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {})
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("storage disabled")
        })
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("storage disabled")
        })
        const { result } = renderHook(() => useLoadable(async () => "fresh", [], { cache: "k" }))
        await flush()
        expect(result.current).toBe("fresh")
    })

    it("StrictMode's double effect still ends loaded", async () => {
        const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
        const { result } = renderHook(() => useLoadable(async () => 3, [], { hideReload: true }), {
            wrapper,
        })
        await flush()
        expect(result.current).toBe(3)
    })

    it("two copies of the library agree on the loading markers", () => {
        expect(loading).toBe(Symbol.for("@tobq/loadable/loading"))
        const foreignToken = { startTime: 1, [Symbol.for("@tobq/loadable/LoadingToken")]: true }
        expect(isLoadingValue(foreignToken)).toBe(true)
        expect(foreignToken instanceof LoadingToken).toBe(true)
        const foreignError = Object.assign(new Error("x"), {
            [Symbol.for("@tobq/loadable/LoadError")]: true,
        })
        expect(foreignError instanceof LoadError).toBe(true)
        expect(hasLoaded(foreignError)).toBe(false)
    })

    it("a deps change under hideReload does not flash loading before the next value", async () => {
        const { fetcher, calls } = controlledFetcher<string>()
        const seen: unknown[] = []
        const { rerender } = renderHook(
            ({ id }) => {
                const v = useLoadable(fetcher, [id], { hideReload: true })
                seen.push(v)
                return v
            },
            { initialProps: { id: 1 } },
        )
        await act(async () => calls[0].deferred.resolve("one"))
        seen.length = 0
        rerender({ id: 2 })
        await act(async () => calls[1].deferred.resolve("two"))
        expect(seen.every(v => v === "one" || v === "two")).toBe(true)
    })
})

