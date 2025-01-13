Below is an updated README that starts with the basics and gradually introduces the concept of a loading token. We focus first on how Loadable works at a high level, then delve into the optional class-based token as a more advanced feature.

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

### LoadError

A custom error class for any load failure:
```ts
export class LoadError extends Error {
  constructor(public readonly cause: unknown, message?: string) {
    super(message ?? (cause instanceof Error ? cause.message : String(cause)))
  }
}
```
If an async fetch fails, your `Loadable<T>` is a `LoadError`. You can handle it however you like.

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
- `hasLoaded(loadable)`, `loadFailed(loadable)`, `all(...)`, `map(...)`, `toOptional(...)`, etc.

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
- **Familiar**: Similar to `useEffect`, but with a focus on minimal boilerplate.

Get rid of manual loading checks and experience simpler, more maintainable React apps. Give **Loadable** a try today!