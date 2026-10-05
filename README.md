# Loadable

A lightweight, type-safe, and composable library for managing asynchronous data in React. **Loadable** provides hooks and utilities to make fetching data clean, declarative, and free from repetitive "loading" and "error" state boilerplate. It's an alternative to manually writing `useState + useEffect` or using heavier data-fetching libraries.

## Table of Contents
- [Overview](#overview)
- [Installation](#installation)
- [Core Concepts](#core-concepts)
- [Quick Start](#quick-start)
	- [Basic Example](#basic-example)
	- [Chaining Async Calls](#chaining-async-calls)
	- [Fetching Multiple Loadables](#fetching-multiple-loadables)
- [Reloads that stay on screen: `useLoadableQuery`](#reloads-that-stay-on-screen-useloadablequery)
- [Showing load state: the UI contract](#showing-load-state-the-ui-contract)
- [Hooks & Utilities](#hooks--utilities)
- [Migrating Common Patterns](#migrating-common-patterns)
- [Error Handling](#error-handling)
- [Caching (deprecated)](#caching-deprecated)
- [Comparison with Alternatives](#comparison-with-alternatives)
- [Releasing](#releasing)

---

## Overview

React doesn't come with an official solution for data fetching, which often leads to repetitive patterns:
- **Booleans** to track loading states.
- **Conditionals** to check null data or thrown errors.
- **Cleanups** to avoid updating unmounted components.

**Loadable** unifies these concerns:
- A **single type** encapsulates "loading," "loaded," and "error" states.
- Easy-to-use **hooks** (`useLoadable`, `useThen`, `useLoadableQuery`, etc.) to chain and compose fetches.
- Automatic **cancellation** of in-flight requests: a superseded request is aborted and never shows up as an error.

---

## Installation

```bash
npm install @tobq/loadable
```

Works with React 18.2+ and React 19. Ships ESM and CommonJS builds with types.

---

## Core Concepts

### Loadable Type

A `Loadable<T>` is exactly one of:

| Value | Meaning |
|---|---|
| `loading` | Nothing to show yet. |
| `LoadingToken<T>` | Loading. On a reload it carries the value it replaces as `previous`. |
| `T` | Loaded. |
| `LoadError<T>` | Failed. When a good value was already shown it carries that as `previous`. |

This single union replaces the usual `isLoading` / `data` / `error` triple, and it cannot represent nonsense such as "loaded and failed at once". The previous value travels **inside** the loading and failure markers, so a view can keep showing it (dimmed) instead of collapsing to a spinner. Read it with `latest(x)`:

```ts
latest(5)                                            // 5
latest(loading)                                      // undefined
latest(new LoadingToken(Date.now(), { previous: 5 })) // 5
latest(new LoadError(err, undefined, { previous: 5 })) // 5
```

`loading` is registered with `Symbol.for`, and both marker classes are recognised by brand, so two copies of this library in one app (an ESM and a CJS build, say) still agree on what is loading.

---

## Quick Start

### Basic Example

#### Without Loadable

```tsx
function Properties() {
  const [properties, setProperties] = useState<Property[] | null>(null)
  const [isLoading, setLoading] = useState(true)

  useEffect(() => {
    getPropertiesAsync()
      .then((props) => {
        setProperties(props)
        setLoading(false)
      })
      .catch(console.error)
  }, [])

  if (isLoading || !properties) {
    return <div>Loading…</div>
  }
  return (
    <div>
      {properties.map((p) => (
        <PropertyCard key={p.id} property={p} />
      ))}
    </div>
  )
}
```

#### With Loadable

```tsx
import { useLoadable, hasLoaded } from "@tobq/loadable"

function Properties() {
  const properties = useLoadable((signal) => getPropertiesAsync(signal), [])

  if (!hasLoaded(properties)) {
    return <div>Loading…</div>
  }
  return (
    <div>
      {properties.map((p) => (
        <PropertyCard key={p.id} property={p} />
      ))}
    </div>
  )
}
```

- No "isLoading" boolean or separate error state needed.
- `properties` starts as `loading` and becomes the loaded data when ready.
- `hasLoaded(properties)` ensures the data is neither loading nor an error.

### Chaining Async Calls

```tsx
import { useLoadable, useThen, hasLoaded } from "@tobq/loadable"

function UserProfile({ userId }) {
  const user = useLoadable(() => fetchUser(userId), [userId])
  const posts = useThen(user, (u) => fetchPostsForUser(u.id))

  if (!hasLoaded(user)) return <div>Loading user…</div>
  if (!hasLoaded(posts)) return <div>Loading posts…</div>

  return (
    <div>
      <h1>{user.name}</h1>
      {posts.map((p) => (
        <Post key={p.id} {...p} />
      ))}
    </div>
  )
}
```

### Fetching Multiple Loadables

```tsx
import { useAllThen, hasLoaded } from "@tobq/loadable"

function Dashboard() {
  const user = useLoadable(() => fetchUser(), [])
  const stats = useLoadable(() => fetchStats(), [])

  const summary = useAllThen(
    [user, stats],
    (u, s, signal) => fetchDashboardSummary(u.id, s.range, signal),
    []
  )

  if (!hasLoaded(summary)) return <div>Loading Dashboard…</div>

  return <DashboardSummary {...summary} />
}
```

---

## Reloads that stay on screen: `useLoadableQuery`

`useLoadable` resets to `loading` whenever its deps change (or, with `hideReload`, silently keeps the old value). Neither tells the user that the number they are looking at is about to change. `useLoadableQuery` does:

```tsx
import { useLoadableQuery, useLoadState, latest, loadFailed } from "@tobq/loadable"

function Usage({ range }) {
  const [usage, reload] = useLoadableQuery(
    (signal) => fetchUsage(range, signal),
    [range],
    { debounceMs: 180, refreshMs: 60_000 }
  )
  const state = useLoadState(usage) // "loading" | "pending" | "stale" | undefined
  const shown = latest(usage)

  return (
    <section>
      <Stat label="Requests" value={shown?.requests} state={state} />
      <Chart series={shown?.series} state={state} />
      {loadFailed(usage) && <LoadFailed what="usage" error={usage} onRetry={reload} />}
    </section>
  )
}
```

It returns `[result, reload]`, where `result` is the same `Loadable<T>` union:

- **First load**: `loading` until there is something to show.
- **Deps change or `reload()`**: a `LoadingToken` carrying the previous value, from the very render the deps changed in (no frame of the old value posing as current). A burst of changes keeps one token, so the wait is measured from when it began.
- **Failure after good data**: a `LoadError` carrying the last good value. A first load that fails carries nothing.
- **Superseded requests** are aborted, and never reported as failures or to `onError`.

Options:

| Option | Effect |
|---|---|
| `debounceMs` | Wait this long after a deps change before fetching, so typing or dragging costs one request. The first load and `reload()` are never debounced. |
| `refreshMs` | Refresh silently on this interval (the value stays as it is; no pending marker). Paused while the page is hidden, caught up on return, never overlapping a request in flight. One failed refresh is ignored; `BACKGROUND_MISSES_BEFORE_FAILURE` (2) in a row becomes a `LoadError` carrying the data. |
| `prefetched` | Data already in hand for the **first** deps key: a value or `LoadError` is shown with no request; a promise replaces the first fetch (and survives StrictMode's double effect). |
| `onError` | Called whenever the result becomes a `LoadError`. A throwing handler cannot wedge the hook. |

---

## Showing load state: the UI contract

Every app that renders loadables should present them the same way, so the library ships the decision and each UI kit ships the look. The vocabulary:

| `LoadState` | Show |
|---|---|
| `"loading"` | The slot's own skeleton, **in its real place** inside the real layout. Never a page-sized placeholder: the skeleton is the real structure with the values missing. |
| `"pending"` | The previous value, dimmed, with a shimmer over it. Charts and tables dim with a thin sweep line. The new value fades in. |
| `"stale"` | The previous value, dimmed, plus one line saying what failed and a Retry. |
| `undefined` | The value as it is, or the missing dash when there is none. |

- `useLoadState(result, { graceMs? })` holds `"pending"` back for `PENDING_GRACE_MS` (150 ms), so a fast reload never flickers. The grace runs from the token's `startTime`: a wait that began long ago shows at once.
- `loadStateOf(result)` is the same mapping with no grace, for non-hook code.
- `useDelayedFlag(active, ms, { sinceMs, resetKey })` is the grace primitive, for any other wait worth explaining only once it is noticeable.

The component names a kit should expose, so code reads the same in every app:

- `LoadingBlock`: the shimmer primitive a skeleton slot is made of.
- `LoadFailed { what, error, onRetry }`: the inline "what failed + Retry" line.
- A `state?: LoadState` prop on every value-showing component (stat, number, meter, chart, table, chip), which also sets `aria-busy`.
- Controls whose options depend on data render in place, disabled, until the data arrives; a button running an action shows it is busy and cannot be pressed twice.

---

## Hooks & Utilities

- **`useLoadableQuery(fetcher, deps, options?)`**: `[result, reload]`, keeping the previous value through reloads. See above.
- **`useLoadable(fetcher, deps, options?)`**: returns a `Loadable<T>` by calling the async `fetcher`.
- **`useThen(loadable, fetcher, deps?, options?)`**: waits for a loadable, then chains another async call.
- **`useAllThen(loadables, fetcher, deps?, options?)`**: waits for several loadables, then calls `fetcher`.
- **`useLoadableWithCleanup(fetcher, deps, options?)`**: like `useLoadable`, plus a function that aborts the request in flight.
- **`useLoadState(loadable, opts?)`**, **`loadStateOf(loadable)`**, **`useDelayedFlag(...)`**: presentation state, see the UI contract.

**Helpers**: `latest`, `hasLoaded`, `loadFailed`, `isLoadingValue`, `all`, `map` (applies to a carried previous value too), `toOptional`, `orElse`, `isUsable`.

---

## Migrating Common Patterns

### Manual Loading States

**Before**:
```tsx
const [data, setData] = useState<T | null>(null)
const [loading, setLoading] = useState(true)
const [error, setError] = useState<Error | null>(null)

useEffect(() => {
  setLoading(true)
  getData()
    .then(res => setData(res))
    .catch(err => setError(err))
    .finally(() => setLoading(false))
}, [])
```

**After**:
```tsx
const loadable = useLoadable(() => getData(), [])

if (loadFailed(loadable)) {
  return <ErrorComponent error={loadable} />
}
if (!hasLoaded(loadable)) {
  return <LoadingSpinner />
}

return <RenderData data={loadable} />
```

### Filters that refetch

**Before** (the number silently jumps when the filter changes):
```tsx
const stats = useLoadable((signal) => fetchStats(filter, signal), [filter], { hideReload: true })
```

**After** (the old number dims while the new one loads):
```tsx
const [stats, reload] = useLoadableQuery((signal) => fetchStats(filter, signal), [filter], { debounceMs: 180 })
<Stat value={latest(stats)?.total} state={useLoadState(stats)} />
```

---

## Error Handling

If a fetch fails, the hooks return a `LoadError` (with the raw error as `cause`). An aborted request (deps changed, unmounted) is never an error.

```tsx
const users = useLoadable(fetchUsers, [], {
  onError: (error) => console.error("Error loading users:", error)
})

if (loadFailed(users)) {
  return <ErrorBanner error={users} />
}
if (!hasLoaded(users)) {
  return <Spinner />
}

return <UsersList items={users} />
```

A fetcher that throws synchronously, or an `onError` handler that throws, still ends in a `LoadError` rather than a crash or a hook stuck on loading.

---

## Caching (deprecated)

The `cache` option of `useLoadable` (`string | { key, store }`) still works but will be removed in 3.0: it never revalidates and its keys are global. A broken store (storage disabled, quota) now reads as a miss instead of hanging the hook. Keep data you want across mounts in your own store and pass it as `prefetched`.

---

## Comparison with Alternatives

- **React Query / SWR / Apollo**: powerful, feature-rich solutions (shared caches, mutations, devtools), which can be overkill if you don't need those extras.
- **Manual `useEffect`**: often leads to repetitive loading booleans and tricky cleanup logic. Loadable unifies these states for you.
- **Redux**: heavy if you only need local data fetching without global state.

---

## Releasing

```bash
npm version <patch|minor|major>   # bumps package.json and tags v<version>
npm run release                    # pushes the commit and tag
```

Pushing a `v*.*.*` tag runs the publish workflow, which checks the tag matches `package.json`, then typechecks, tests and builds (`prepublishOnly`) before publishing to npm.
