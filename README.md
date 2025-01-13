Below is an updated **README** that includes a section on **caching**. It starts with the basics and gradually introduces the concept of a loading token, then covers how to leverage caching (using in-memory, `localStorage`, or `indexedDB`).

---

# Loadable

A lightweight, type-safe, and composable library for managing asynchronous data in React. **Loadable** provides hooks and utilities to make fetching data clean, declarative, and free from repetitive “loading” and “error” state boilerplate. It’s an alternative to manually writing `useState + useEffect` or using heavier data-fetching libraries.

## Table of Contents
- [Overview](#overview)
- [Core Concepts](#core-concepts)
- [Quick Start](#quick-start)
	- [Basic Example](#basic-example)
	- [Chaining Async Calls](#chaining-async-calls)
	- [Fetching Multiple Loadables](#fetching-multiple-loadables)
- [Hooks & Utilities](#hooks--utilities)
- [Migrating Common Patterns](#migrating-common-patterns)
- [Error Handling](#error-handling)
- [Caching](#advanced-caching)
- [Comparison with Alternatives](#comparison-with-alternatives)
- [Why Loadable?](#why-loadable)

---

## Overview

React doesn’t come with an official solution for data fetching, which often leads to repetitive patterns:
- **Booleans** to track loading states.
- **Conditionals** to check null data or thrown errors.
- **Cleanups** to avoid updating unmounted components.

**Loadable** unifies these concerns:
- A **single type** encapsulates “loading,” “loaded,” and “error” states.
- Easy-to-use **hooks** (`useLoadable`, `useThen`, etc.) to chain and compose fetches.
- Automatic **cancellation** of in-flight requests to avoid stale updates.

---

## Installation

```bash
npm install @tobq/loadable
# or
yarn add @tobq/loadable
```

---

## Core Concepts

### Loadable Type

A `Loadable<T>` can be:
1. **Loading**: represented by a special `loading` symbol (or an optional “loading token”).
2. **Loaded**: the actual data of type `T`.
3. **Failed**: a `LoadError` object describing the failure.

This single union type replaces the typical `isLoading` / `data` / `error` triple.

---

## Quick Start

### Basic Example

Below is a minimal comparison of how you might load data **with** and **without** Loadable:

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
  const properties = useLoadable(() => getPropertiesAsync(), [])

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

- No “isLoading” boolean or separate error state needed.
- `properties` starts as `loading` and becomes the loaded data when ready.
- `hasLoaded(properties)` ensures the data is neither loading nor an error.

### Chaining Async Calls

```tsx
import { useLoadable, useThen, hasLoaded } from "@tobq/loadable"

function UserProfile({ userId }) {
  // First load the user
  const user = useLoadable(() => fetchUser(userId), [userId])

  // Then load the user’s posts, using the loaded `user`
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

Use `useAllThen` or the `all()` helper to coordinate multiple loadable values:

```tsx
import { useAllThen, hasLoaded } from "@tobq/loadable"

function Dashboard() {
  const user = useLoadable(() => fetchUser(), [])
  const stats = useLoadable(() => fetchStats(), [])

  // Wait for both to be loaded, then call `fetchDashboardSummary()`
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

## Hooks & Utilities

- **`useLoadable(fetcher, deps, options?)`**  
  Returns a `Loadable<T>` by calling the async `fetcher`.
- **`useThen(loadable, fetcher, deps?, options?)`**  
  Waits for a loadable to finish, then chains another async call.
- **`useAllThen(loadables, fetcher, deps?, options?)`**  
  Waits for multiple loadables to finish, then calls `fetcher`.
- **`useLoadableWithCleanup(fetcher, deps, options?)`**  
  Like `useLoadable`, but returns `[Loadable<T>, cleanupFunc]` for manual aborts.

**Helpers** include:
- `hasLoaded(loadable)`
- `loadFailed(loadable)`
- `all(...)`
- `map(...)`
- `toOptional(...)`
- `orElse(...)`
- `isUsable(...)`

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
import { useLoadable, loadFailed, hasLoaded } from "@tobq/loadable"

const loadable = useLoadable(() => getData(), [])

if (loadFailed(loadable)) {
  return <ErrorComponent error={loadable} />
}
if (!hasLoaded(loadable)) {
  return <LoadingSpinner />
}

return <RenderData data={loadable} />
```

### Chaining Fetches

**Before**:
```tsx
useEffect(() => {
  let cancelled = false

  getUser().then(user => {
    if (!cancelled) {
      setUser(user)
      getUserPosts(user.id).then(posts => {
        if (!cancelled) {
          setPosts(posts)
        }
      })
    }
  })

  return () => { cancelled = true }
}, [])
```

**After**:
```tsx
const user = useLoadable(() => getUser(), [])
const posts = useThen(user, (u) => getUserPosts(u.id))
```

---

## Error Handling

By default, if a fetch fails, `useLoadable` returns a `LoadError`. You can handle or display it:

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

---

## Advanced: Symbol vs. Class-based Loading Token

By default, **Loadable** uses a single symbol `loading` to represent the “loading” state. If you need **unique tokens** for better debugging or timestamp tracking, you can opt for the **class-based** token:

```ts
import { LoadingToken, newLoadingToken } from "@tobq/loadable"

const token = newLoadingToken() // brand-new token with a timestamp
```
You can store additional metadata (like `startTime`) in the token. Internally, the library handles both `loading` (symbol) and `LoadingToken` interchangeably.

---

## Advanced: Caching

Loadable supports optional caching of fetched data, allowing you to bypass refetching if the data already exists in **memory**, **localStorage**, or **indexedDB**.

### Using `cache` in `useLoadable`

Within the **`options`** object passed to `useLoadable`, you can include:

```ts
cache?: string | {
  key: string
  store?: "memory" | "localStorage" | "indexedDB"
}
```

1. **String** (e.g. `cache: "myDataKey"`):
	- Interpreted as the cache key, defaults to `"localStorage"` for storage.
2. **Object** (e.g. `cache: { key: "myDataKey", store: "indexedDB" }`):
	- Fully specifies both the cache key and the storage backend.

#### Example

```tsx
function MyComponent() {
  // #1: Simple string for cache => defaults to localStorage
  const dataLoadable = useLoadable(fetchMyData, [], {
    cache: "myDataKey",
    hideReload: false,
    onError: (err) => console.error("Load error:", err),
  })

  if (dataLoadable === loading) {
    return <div>Loading...</div>
  }
  if (!hasLoaded(dataLoadable)) {
    // must be an error
    return <div>Error: {dataLoadable.message}</div>
  }

  return <pre>{JSON.stringify(dataLoadable, null, 2)}</pre>
}
```

The first time the component mounts, it checks `localStorage["myDataKey"]`.
- If **not found**, it fetches from the server, **writes** to localStorage, and returns the result.
- Subsequent renders can immediately read from localStorage before re-fetching or revalidating (depending on `hideReload` or your logic).

### Cache Stores

- **`memory`**: A global in-memory map (fast, but resets on page refresh).
- **`localStorage`**: Persists across refreshes, limited by localStorage size (~5MB in many browsers).
- **`indexedDB`**: Can store larger data more efficiently, though usage is a bit more complex.

### Notes on Caching Strategy

- **Stale-While-Revalidate**: You can display cached data immediately while you do a new fetch in the background. Setting `hideReload: true` means you don’t revert to a “loading” state once something is cached; you only show the old data until the new fetch finishes.
- **TTL or Expiration**: This minimal caching approach doesn’t implement TTL. For more complex logic, you can store timestamps or version data in your cached objects and skip using stale data if it’s outdated.
- **Error Handling**: If the cached data is present but you still want to re-fetch, you can always ignore or override the cache. The code is flexible enough to support these flows.

---

## Comparison with Alternatives

- **React Query / SWR / Apollo**: Powerful, feature-rich solutions (caching, revalidation, etc.), which can be overkill if you don’t need those extras.
- **Manual `useEffect`**: Often leads to repetitive loading booleans and tricky cleanup logic. Loadable unifies these states for you.
- **Redux**: While Redux can handle async, it’s heavy if you only need local data fetching without global state.

---

## Why Loadable?

- **Less Boilerplate**: Eliminate scattered `useState` variables and conditionals for loading/error states.
- **Declarative**: Compose async operations with `useLoadable`, `useThen`, `useAllThen`, etc.
- **Safe & Explicit**: Distinguish between `loading`, a `LoadError`, or real data in one type.
- **Flexible**: Use a simple symbol or a class-based token with timestamps or custom fields.
- **Caching**: Optionally store and retrieve data from memory, localStorage, or IndexedDB with minimal extra code.
- **Familiar**: Similar to `useEffect`, but with a focus on minimal boilerplate.

Get rid of manual loading checks and experience simpler, more maintainable React apps. Give **Loadable** a try today!