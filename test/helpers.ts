import { act } from "@testing-library/react"

export interface Deferred<T> {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (error: unknown) => void
}

export function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

/** A fetcher whose calls are recorded, each answered by hand through its own deferred. Rejects with
 *  an AbortError when its signal aborts, the way `fetch` does, so abort handling is exercised. */
export function controlledFetcher<T>() {
    const calls: { signal: AbortSignal; deferred: Deferred<T> }[] = []
    const fetcher = (signal: AbortSignal) => {
        const d = deferred<T>()
        signal.addEventListener("abort", () => {
            const error = new Error("The operation was aborted.")
            error.name = "AbortError"
            d.reject(error)
        })
        calls.push({ signal, deferred: d })
        return d.promise
    }
    return { fetcher, calls }
}

/** Lets pending promise callbacks and the React updates they schedule run. */
export async function flush(): Promise<void> {
    await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve()
    })
}
