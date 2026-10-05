import { act, render, renderHook } from "@testing-library/react"
import { StrictMode, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
    BACKGROUND_MISSES_BEFORE_FAILURE,
    latest,
    loadFailed,
    LoadError,
    loading,
    LoadingToken,
    loadStateOf,
    map,
    PENDING_GRACE_MS,
    useDelayedFlag,
    useLoadableQuery,
    useLoadState,
    type Loadable,
} from "../src"
import { controlledFetcher, deferred, flush } from "./helpers"

function setHidden(hidden: boolean) {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden })
    document.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    setHidden(false)
})

describe("latest and map over markers", () => {
    it("latest reads the value, else the carried previous, else undefined", () => {
        expect(latest(5)).toBe(5)
        expect(latest(loading)).toBeUndefined()
        expect(latest(new LoadingToken())).toBeUndefined()
        expect(latest(new LoadingToken(1, { previous: 4 }))).toBe(4)
        expect(latest(new LoadError("x", undefined, { previous: 3 }))).toBe(3)
        expect(latest(new LoadError("x"))).toBeUndefined()
    })

    it("a carried undefined still counts as a previous value", () => {
        const token = new LoadingToken<number | undefined>(1, { previous: undefined })
        expect(token.hasPrevious).toBe(true)
        expect(loadStateOf(token)).toBe("pending")
    })

    it("map applies to the carried previous and keeps the wait's start", () => {
        const token = map(new LoadingToken(77, { previous: 2 }) as Loadable<number>, v => v * 10)
        expect(token).toBeInstanceOf(LoadingToken)
        expect((token as LoadingToken<number>).startTime).toBe(77)
        expect(latest(token)).toBe(20)
        const failed = map(new LoadError("x", "msg", { previous: 2 }) as Loadable<number>, v => v + 1)
        expect(loadFailed(failed) && failed.message).toBe("msg")
        expect(latest(failed)).toBe(3)
    })
})

describe("useLoadableQuery", () => {
    it("loads, then on a deps change returns the previous value as pending from the same render", async () => {
        const { fetcher, calls } = controlledFetcher<string>()
        const { result, rerender } = renderHook(({ id }) => useLoadableQuery(fetcher, [id])[0], {
            initialProps: { id: 1 },
        })
        expect(result.current).toBe(loading)
        await act(async () => calls[0].deferred.resolve("one"))
        expect(result.current).toBe("one")

        rerender({ id: 2 })
        expect(result.current).toBeInstanceOf(LoadingToken)
        expect(latest(result.current)).toBe("one")
        await act(async () => calls[1].deferred.resolve("two"))
        expect(result.current).toBe("two")
    })

    it("keeps one token across a burst of changes, so the wait is measured from its start", async () => {
        const { fetcher, calls } = controlledFetcher<string>()
        const { result, rerender } = renderHook(({ id }) => useLoadableQuery(fetcher, [id])[0], {
            initialProps: { id: 1 },
        })
        await act(async () => calls[0].deferred.resolve("one"))
        rerender({ id: 2 })
        const first = result.current
        rerender({ id: 3 })
        expect(result.current).toBe(first)
    })

    it("debounces deps changes but not the first load", async () => {
        const fetcher = vi.fn(async (_: AbortSignal) => "x")
        const { rerender } = renderHook(
            ({ id }) => useLoadableQuery(fetcher, [id], { debounceMs: 200 })[0],
            { initialProps: { id: 1 } },
        )
        expect(fetcher).toHaveBeenCalledTimes(1)
        await flush()
        rerender({ id: 2 })
        rerender({ id: 3 })
        rerender({ id: 4 })
        expect(fetcher).toHaveBeenCalledTimes(1)
        await act(async () => vi.advanceTimersByTime(199))
        expect(fetcher).toHaveBeenCalledTimes(1)
        await act(async () => vi.advanceTimersByTime(1))
        expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it("aborts a superseded request and never surfaces it", async () => {
        const onError = vi.fn()
        const { fetcher, calls } = controlledFetcher<string>()
        const seen: unknown[] = []
        const { rerender } = renderHook(
            ({ id }) => {
                const [r] = useLoadableQuery(fetcher, [id], { onError })
                seen.push(r)
                return r
            },
            { initialProps: { id: 1 } },
        )
        rerender({ id: 2 })
        await flush()
        expect(calls[0].signal.aborted).toBe(true)
        expect(seen.some(v => v instanceof LoadError)).toBe(false)
        expect(onError).not.toHaveBeenCalled()
    })

    it("ignores a late result from an older request", async () => {
        const fetches = [deferred<string>(), deferred<string>()]
        let n = 0
        const { result, rerender } = renderHook(
            ({ id }) => useLoadableQuery(() => fetches[n++].promise, [id])[0],
            { initialProps: { id: 1 } },
        )
        rerender({ id: 2 })
        await act(async () => fetches[1].resolve("new"))
        await act(async () => fetches[0].resolve("old"))
        expect(result.current).toBe("new")
    })

    it("a failure after good data keeps that data as previous; reload recovers", async () => {
        const onError = vi.fn()
        const { fetcher, calls } = controlledFetcher<string>()
        const { result } = renderHook(() => useLoadableQuery(fetcher, [], { onError }))
        await act(async () => calls[0].deferred.resolve("good"))
        act(() => result.current[1]())
        expect(latest(result.current[0])).toBe("good")
        expect(result.current[0]).toBeInstanceOf(LoadingToken)
        const cause = new Error("down")
        await act(async () => calls[1].deferred.reject(cause))
        const failed = result.current[0]
        expect(loadFailed(failed)).toBe(true)
        expect(latest(failed)).toBe("good")
        expect((failed as LoadError).cause).toBe(cause)
        expect(onError).toHaveBeenCalledWith(cause)
        act(() => result.current[1]())
        await act(async () => calls[2].deferred.resolve("again"))
        expect(result.current[0]).toBe("again")
    })

    it("a first load that fails has nothing to carry", async () => {
        const { fetcher, calls } = controlledFetcher<string>()
        const { result } = renderHook(() => useLoadableQuery(fetcher, []))
        await act(async () => calls[0].deferred.reject(new Error("no")))
        expect(loadFailed(result.current[0])).toBe(true)
        expect(latest(result.current[0])).toBeUndefined()
        act(() => result.current[1]())
        expect(result.current[0]).toBe(loading)
    })

    it("stores a function result as a value", async () => {
        const fn = () => 1
        const { result } = renderHook(() => useLoadableQuery(async () => fn, [])[0])
        await flush()
        expect(result.current).toBe(fn)
    })

    it("turns a synchronous throw into a LoadError", async () => {
        const { result } = renderHook(
            () =>
                useLoadableQuery((): Promise<number> => {
                    throw new Error("sync")
                }, [])[0],
        )
        await flush()
        expect(loadFailed(result.current)).toBe(true)
    })

    describe("prefetched", () => {
        it("a value is shown with no request", async () => {
            const fetcher = vi.fn(async () => 1)
            const { result } = renderHook(() => useLoadableQuery(fetcher, [], { prefetched: 9 })[0])
            await flush()
            expect(result.current).toBe(9)
            expect(fetcher).not.toHaveBeenCalled()
        })

        it("a promise replaces the first fetch, once, even under StrictMode", async () => {
            const fetcher = vi.fn(async () => "fetched")
            const pre = deferred<string>()
            const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
            const { result, rerender } = renderHook(
                ({ id }) => useLoadableQuery(fetcher, [id], { prefetched: pre.promise })[0],
                { initialProps: { id: 1 }, wrapper },
            )
            await act(async () => pre.resolve("early"))
            expect(result.current).toBe("early")
            expect(fetcher).not.toHaveBeenCalled()
            rerender({ id: 2 })
            await flush()
            expect(fetcher).toHaveBeenCalledTimes(1)
            expect(result.current).toBe("fetched")
        })
    })

    describe("enabled", () => {
        it("holds the first load until enabled, then loads the current deps", async () => {
            const fetcher = vi.fn(async (_: AbortSignal) => "x")
            const { result, rerender } = renderHook(
                ({ ready, id }) => useLoadableQuery(fetcher, [id], { enabled: ready, debounceMs: 200 })[0],
                { initialProps: { ready: false, id: 1 } },
            )
            rerender({ ready: false, id: 2 })
            await flush()
            expect(fetcher).not.toHaveBeenCalled()
            expect(result.current).toBe(loading)
            rerender({ ready: true, id: 2 })
            await flush()
            // The held first load is not debounced: nothing has loaded yet.
            expect(fetcher).toHaveBeenCalledTimes(1)
            expect(result.current).toBe("x")
        })

        it("abandons a request in flight and refreshes nothing while disabled", async () => {
            const { fetcher, calls } = controlledFetcher<string>()
            const { rerender } = renderHook(
                ({ ready }) => useLoadableQuery(fetcher, [], { enabled: ready, refreshMs: 1000 }),
                { initialProps: { ready: true } },
            )
            rerender({ ready: false })
            expect(calls[0].signal.aborted).toBe(true)
            await act(async () => vi.advanceTimersByTime(5000))
            expect(calls).toHaveLength(1)
        })
    })

    describe("refreshMs", () => {
        it("refreshes silently, keeping the value (no pending marker)", async () => {
            let n = 0
            const seen: unknown[] = []
            renderHook(() => {
                const [r] = useLoadableQuery(async () => ++n, [], { refreshMs: 1000 })
                seen.push(r)
                return r
            })
            await flush()
            await act(async () => vi.advanceTimersByTime(1000))
            await flush()
            expect(n).toBe(2)
            expect(seen.filter(v => v instanceof LoadingToken)).toHaveLength(0)
            expect(seen[seen.length - 1]).toBe(2)
        })

        it("surfaces a failure only after consecutive misses, keeping the data", async () => {
            expect(BACKGROUND_MISSES_BEFORE_FAILURE).toBe(2)
            let fail = false
            const onError = vi.fn()
            const { result } = renderHook(() =>
                useLoadableQuery(
                    async () => {
                        if (fail) throw new Error("blip")
                        return "data"
                    },
                    [],
                    { refreshMs: 1000, onError },
                ),
            )
            await flush()
            fail = true
            await act(async () => vi.advanceTimersByTime(1000))
            await flush()
            expect(result.current[0]).toBe("data")
            expect(onError).not.toHaveBeenCalled()
            await act(async () => vi.advanceTimersByTime(1000))
            await flush()
            expect(loadFailed(result.current[0])).toBe(true)
            expect(latest(result.current[0])).toBe("data")
            expect(onError).toHaveBeenCalledTimes(1)
            fail = false
            await act(async () => vi.advanceTimersByTime(1000))
            await flush()
            expect(result.current[0]).toBe("data")
        })

        it("pauses while hidden and catches up on return", async () => {
            const fetcher = vi.fn(async () => "x")
            renderHook(() => useLoadableQuery(fetcher, [], { refreshMs: 1000 }))
            await flush()
            setHidden(true)
            await act(async () => vi.advanceTimersByTime(5000))
            expect(fetcher).toHaveBeenCalledTimes(1)
            await act(async () => setHidden(false))
            await flush()
            expect(fetcher).toHaveBeenCalledTimes(2)
        })

        it("never overlaps a request in flight", async () => {
            const { fetcher, calls } = controlledFetcher<string>()
            renderHook(() => useLoadableQuery(fetcher, [], { refreshMs: 1000 }))
            await act(async () => vi.advanceTimersByTime(5000))
            expect(calls).toHaveLength(1)
        })

        it("stops on unmount", async () => {
            const fetcher = vi.fn(async () => "x")
            const { unmount } = renderHook(() => useLoadableQuery(fetcher, [], { refreshMs: 1000 }))
            await flush()
            unmount()
            await act(async () => vi.advanceTimersByTime(5000))
            expect(fetcher).toHaveBeenCalledTimes(1)
        })
    })
})

describe("useLoadState", () => {
    it("is loading with nothing to show, and holds pending back for the grace", async () => {
        vi.setSystemTime(10_000)
        const { result, rerender } = renderHook(({ r }: { r: Loadable<number> }) => useLoadState(r), {
            initialProps: { r: loading as Loadable<number> },
        })
        expect(result.current).toBe("loading")
        rerender({ r: 5 })
        expect(result.current).toBeUndefined()
        rerender({ r: new LoadingToken(Date.now(), { previous: 5 }) })
        expect(result.current).toBeUndefined()
        await act(async () => vi.advanceTimersByTime(PENDING_GRACE_MS))
        expect(result.current).toBe("pending")
        rerender({ r: new LoadError("x", undefined, { previous: 5 }) })
        expect(result.current).toBe("stale")
        rerender({ r: new LoadError("x") })
        expect(result.current).toBeUndefined()
    })

    it("a wait that began long ago is pending from the first render", () => {
        vi.setSystemTime(10_000)
        const { result } = renderHook(() => useLoadState(new LoadingToken(1_000, { previous: 1 })))
        expect(result.current).toBe("pending")
    })
})

describe("useDelayedFlag", () => {
    function Probe(props: { active: boolean; sinceMs?: number }) {
        return <span>{String(useDelayedFlag(props.active, 100, { sinceMs: props.sinceMs }))}</span>
    }

    it("turns on after the grace and off at once", async () => {
        const { container, rerender } = render(<Probe active />)
        expect(container.textContent).toBe("false")
        await act(async () => vi.advanceTimersByTime(100))
        expect(container.textContent).toBe("true")
        rerender(<Probe active={false} />)
        expect(container.textContent).toBe("false")
    })
})
