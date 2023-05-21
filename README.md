# Loadable

Loadable is a library that simplifies loading asynchronous data in your React components. By managing the complexities of data loading, error, and ready states in a unified, abstract way, it minimizes the boilerplate and enhances the readability of your code.

## Installation

To get started, install the Loadable library via npm or yarn:

```sh
npm i @tobq/loadable
```

## Features

Loadable provides the following features:

1. **Loading state management**: Abstracts away the need for manual loading state management.

2. **Error Handling**: Allows you to handle errors effectively during data fetching.

3. **Data fetching based on dependencies**: Similar to `useEffect`, you can fetch data depending on certain dependencies.

4. **Synchronous and asynchronous data fetching**: Facilitates both synchronous and asynchronous data fetching functions.

5. **Composability**: Allows you to compose hooks and utilities to create complex data fetching flows.

6. **Type-Safe**: Provides excellent TypeScript support with full typing.

## Usage

### Basic Usage

With Loadable, you can manage loading states more efficiently, eliminating the need to manually do so. Here's a simple comparison:

#### With Loadable

```tsx
function Properties() {
    const properties = useLoadable(getPropertiesAsync)

    return hasLoaded(properties) ?
        properties.map(property => <PropertyCard property={property}/>) :
        "PROPERTIES LOADING"
}
```

#### Without Loadable

```tsx
function Properties() {
    const [properties, setProperties] = useState<Property[] | null>(null)
    const [isLoading, setLoading] = useState(true)

    useEffect(() => {
        getPropertiesAsync()
            .then(properties => {
                setProperties(properties)
                setLoading(false)
            })
    }, [])

    return !isLoading && properties !== null ?
        properties.map(property => <PropertyCard property={property}/>) :
        "PROPERTIES LOADING"
}
```

In the Loadable example, you no longer need to maintain a separate `isLoading` state. The `useLoadable` hook handles this
for you. The `properties` variable will either contain the symbol `loading` when the data is still loading, or the loaded data once it's ready. The `hasLoaded` function checks if the data is ready.

### Chaining Async Calls with `useThen`

You may want to fetch data based on the result of a previous fetch operation. The `useThen` hook makes this easy:

```tsx
function UserProfile({userId}) {
    const user = useLoadable(() => fetchUser(userId))
    const posts = useThen(user, (user) => fetchUserPosts(user.id))

    // ...
}
```

### Error Handling

Loadable provides a simple way to handle errors during data fetching. Here's an example:

```tsx
const properties = useLoadable(getPropertiesAsync, [], {onError: (e) => console.error(e)})
```

`useThen` waits for the `user` data to load, then uses the loaded `user` data to fetch the user's posts.

## Interoperability

Loadable can be integrated into other parts of your app. Here's an example of making Auth0's authentication loadable:

```ts
export function useIsAuthenticated(): Loadable<boolean> {
    const auth0 = useAuth0()
    return auth0.isLoading ? loading : auth0.isAuthenticated
}
```

And here's a hook to assert authentication:

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

## Utility Functions

Loadable offers a range of useful hooks and utilities:



### map

```sh
const userId : Loadable<string> = map(userLoadable, user => user.id) 
```

### all

```sh
const loadablePair : Loadable<[User, Post, ...]> = all(userLoadable, postLoadable, ...) 
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

## Why Loadable?

React is a powerful library for building user interfaces but lacks built-in support for data fetching. This leads to manual management of loading states, error states, and ready states in your components, causing your code to become complex and hard to maintain.

Loadable abstracts these common patterns for data fetching in React, making your components more readable and maintainable, while reducing boilerplate code associated with data fetching.

We hope you'll find Loadable beneficial for your projects! Enjoy coding!

