import {useEffect, useRef} from "react";

export type TimeStamp = number

export function currentTimestamp(): TimeStamp {
    return new Date().valueOf()
}

export function useAbort(): () => AbortSignal {
    const abortController = useRef<undefined | AbortController>()

    const abort = () => {
        const current = abortController.current
        const next = new AbortController()
        abortController.current = next
        if (current) {
            current.abort()
            // console.debug("Triggered abort signal and replaced abort controller")
        }
        return next.signal
    }

    useEffect(() => {
        return () => {
            abort()
        }
    }, [])

    return abort
}

