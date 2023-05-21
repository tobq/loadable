# Loadable

This library provides a set of hooks and utility functions to simplify the process of loading asynchronous data in your
React components. The library enables the handling of data loading states in a unified, abstracted way, reducing the
complexity of loading, error, and ready states.

## Getting Started

Install the library using npm or yarn.

```sh
npm i @tobq/loadable
```

### Basic Usage

Here is a simple usage example. The `useLoadable` hook eliminates the need to manually manage loading states.

### Without Loadable React Hooks

```tsx
function Properties() {
    // fetching value / managing loading state
    const [properties, setProperties] = useState<Property[] | null>(null)
    const [isLoading, setLoading] = useState(true)

    useEffect(() => {
        getPropertiesAsync()
            .then(properties => {
                setProperties(properties)
                setLoading(false)
            })
    }, [])

    // displaying loading state
    return !isLoadaing && properties !== null ?
        properties.map(property => <PropertyCard property={property}/>) :
        "PROPERTIES LOADING"
}
```

### With Loadable

```tsx
function Properties() {
    // fetching value
    const properties = useLoadable(getPropertiesAsync)

    // displaying loading state
    return hasLoaded(properties) ?
        properties.map(property => <PropertyCard property={property}/>) :
        "PROPERTIES LOADING"
}
```

In the example above, you no longer need to maintain a separate `isLoading` state. The `useLoadable` hook handles this
for you. The `properties` variable will contain the symbol `loading` when the data is still loading, or the loaded data
once it's ready. You can use the `hasLoaded` function to check if the data is ready.

### Chaining Async Calls with `useThen`

In another use case, you may want to fetch data based on the result of a previous fetch operation. You can do this using
the `useThen` hook.

```tsx
function UserProfile({userId}) {
    // Fetch the user data
    const user = useLoadable(() => fetchUser(userId))

    // Fetch the user's posts once the user data is loaded
    const posts = useThen(user, (user) => fetchUserPosts(user.id))

    // ...
}
```

In this example, `useThen` waits for the `user` data to load. Once it's ready, it uses the loaded `user` data to fetch
the user's posts.

### Interoperability

Here's an example of making Auth0's authentication loadable:

```ts
export function useIsAuthenticated(): Loadable<boolean> {
    const auth0 = useAuth0()
    return auth0.isLoading ? loading : auth0.isAuthenticated
}
```

And here's a hook to assert authentication

```tsx
export function useAuthenticated() {
    const auth = useIsAuthenticated()
    const login = useLogin()

    useThen(auth, () => {
        if (!auth) login()
    })

    if (auth === true) {
        return
    }
    return loading
}

function Page() {
    const auth = useAuthenticated()

    return hasLoaded(auth) ? <AuthenticatedPage/> : <LoadingPage/>
}
```

There are loads of other ways to integrate loadable into your app.

## Utils

There's a large selection of other useful hooks and utilities in the library.

Here are some useful ones:

### map

```sh
const userId : Loadable<string> = map(userLoadable, user => user.id) 
```

### all

```sh
const loadablePair : Loadable<[User, Post]> = all(userLoadable, postLoadable) 
```

### hasLoaded

```sh
if (hasLoaded(loadable)) {
	// loadable is ready to be used - in a type safe way
}
```

### useThen

```tsx
const posts = useThen(user, (user) => fetchUserPosts(user.id))
```

### useLoadable

```tsx
const user = useLoadable(() => fetchAsync(userId))
```

### toOptional

```ts
const user: User | undefined = toOptional(userLoadable)
```





## Features

Here are some of the key features of Loadable React Hooks:

1. __Loading state management__: Abstracts away the need for manual loading state management.

2. __Error Handling__: Provides a way to handle errors during data fetching.

3. __Data fetching based on dependencies__: Similar to `useEffect`, allows you to fetch data based on dependencies.

4. __Synchronous and asynchronous data fetching__: Supports both synchronous and asynchronous data fetching functions.

5. __Composability__: Hooks and utilities can be composed together to create complex data fetching flows.

6. __Type-Safe__: The library is fully typed, which provides excellent TypeScript support.

## Conclusion

By abstracting common patterns for data fetching in React, Loadable React Hooks library can help to make your components
more readable and maintainable, and reduce the boilerplate code associated with data fetching. We hope you find it
useful for your projects!
