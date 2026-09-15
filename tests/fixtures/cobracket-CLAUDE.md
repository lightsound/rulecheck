# CLAUDE.md

Project guidance for Claude Code.

## Project context

cobracket hosts and manages tournaments of any format, from the web or from chat (MCP). Direction: `docs/vision.md`. Domain glossary: `CONTEXT.md` — use its terms in code, docs, and commits. Decisions: `docs/adr/`. Current spec: `docs/specs/mvp.md`.

<!-- solid2-agent-kit:solid-rules:start -->
<!-- Managed by solid2-agent-kit v0.11.1. Do not edit inside this block; run `solid2-kit sync` to update. -->

# Solid 2.0 — not React, not Solid 1.x

This project uses Solid 2.0 (`solid-js` 2.x). The JSX looks like React but the
execution model is different: **a component function runs exactly once, at mount**. Updates
flow from signals/stores directly to the JSX expressions that read them. Components never
re-render. Solid 2.0 is also **incompatible with Solid 1.x** — treat all Solid 1.x knowledge
(pre-2.0 tutorials, blog posts, Stack Overflow answers) as wrong for this codebase.

Before writing non-trivial Solid code, read the `solid-2` skill
(`.cursor/skills/solid-2/SKILL.md` for Cursor, `.claude/skills/solid-2/SKILL.md` for
Claude Code) for full patterns, decision tables, and official documentation URLs.

## Hard rules (React reflexes to unlearn)

1. **Never destructure props.** `function C({ name })` and `const { name } = props` read the
   prop getter once at setup and kill reactivity. Keep `props.x` and read it inside JSX, a
   memo, or an effect compute function. Defaults go at the read site: `props.x ?? fallback`.
   Rest props: `omit(props, "label", "value")`, never `const rest = { ...props }` (a snapshot).
   JSX `{...rest}` is fine once `rest` is a reactive proxy. Rule of thumb: the string `props.`
   must never appear at component-body top level *as a read* (`const x = props.x`); nested
   functions (`() => props.x`, `omit(props, ...)`, `children(() => props.children)`) are fine.
   Mechanically enforced by `solid2-kit check` — run it after editing TSX.
2. **Never read reactive values at component-body top level.** The body runs once, untracked;
   `const v = count()` there is a frozen snapshot (Solid reports `[STRICT_READ_UNTRACKED]`
   in dev, naming the component). Carry the accessor
   (the function itself) into JSX and call it there.
3. Signals are read by **calling** them: `{count()}` in JSX, not `{count}`.
4. **Derived state is a function, not state + effect.** `const full = () => a() + b()`.
   Never write "a signal plus an effect that syncs it". That includes **reset**: to clear
   a signal when another reactive value changes, use a writable derivation —
   `createSignal(() => { source(); return initial; })` (re-runs when `source()` changes;
   the setter still works) — never a `createEffect` whose apply calls the setter. The
   derivation also moves the `source()` read to the read site, under its boundaries.
   (React needs `useState(props.x)` plus a `previousX` comparison reset for the same
   derive-override-reset behavior.)
   Mechanically enforced by `solid2-kit check` (effects whose apply only writes a local
   signal). Use `createMemo` only for expensive
   computations, multiple consumers, or an equality boundary. When several writes can land
   before a flush, use the setter updater (`setCount((c) => c + 1)`); `setCount(count() + 1)`
   reads the last *committed* value and drops the other staged writes. To store a *function*
   in a signal, wrap it: `setHandler(() => myHandler)` — `setHandler(myHandler)` treats it
   as an updater.
5. `class`, not `className`; `for`, not `htmlFor`. `class` accepts strings, conditional
    objects, and nested arrays: `class={["btn", { active: selected() }]}`. Put *conditional*
    names in an object — `class={`btn ${on() ? "on" : ""}`}`, `clsx(...)`, and
    `.filter(Boolean).join(" ")` all work but rebuild the whole string, so Solid cannot
    add/remove one token. `style` objects use CSS property names
    (`"background-color"`, not `backgroundColor`) and numbers do NOT auto-append `px`
    (`width: `${n}px``).
6. **`onInput` for per-keystroke handling.** Solid's `onChange` is the native change event
    (fires on blur/commit), not React's per-keystroke `onChange`. Handlers receive native DOM
    events and run untracked — reading a signal inside a handler always gives the current
    value (stale closures cannot happen; `useCallback` equivalents are unnecessary).
    Checkboxes/radios use `checked={...}`, not `value`. Read fields with
    `event.currentTarget` (the element that owns the handler), not `event.target`
    (a nested child). Never pass a setter as the handler (`onClick={setCount}`) —
    that writes the event object; wrap it: `onClick={() => setCount((c) => c + 1)}`.
    Debounce at the handler (`onInput={debounce(...)}`), never as an effect copying
    one signal into another.
7. **Lists use `<For>`**, never `{list().map(...)}` in reactive JSX and never `key` props.
    `{todos().map((t) => <Row todo={t} />)}` *renders*, then recreates every row on each
    update. Row identity: default = item reference; `keyed={(item) => item.id}` = key function
    (child receives item as an accessor); `keyed={false}` = positional. **Rows from
    server/refetched data (fresh object references on every update — fetch results,
    subscription payloads) must use a key function on a stable id**, or every update
    recreates every row (dev + attribution flags the rebuilds as `[UNSTABLE_LIST_IDENTITY]`). Reference keying is for local arrays whose item identities are
    stable (e.g. store rows). Match the child signature to the mode: default item is the
    **raw** value (`todo.title`); `keyed={(t) => t.id}` / `keyed={false}` pass an
    **accessor** (`todo().title`). Mixing those still “runs” (you render a function, or
    throw). Empty lists: `fallback` on `<For>`, not a `.length` branch around it.
    Sliding windows: `<Repeat from={from()} count={n}>`, not `list.slice(from, from+n)`
    fed to `<For>` (that rebuilds the window array every time).
8. **Effects have two phases**: `createEffect(compute, apply)`. All reactive reads go in
    `compute`; its return value feeds `apply`, which does imperative work and may return a
    cleanup. Single-argument `createEffect(fn)` is an error in Solid 2. Do not substitute
    `createTrackedEffect` for that — it is an advanced one-callback form that cannot nest
    primitives. Skip the initial run with `{ defer: true }`. Most React `useEffect` code should not become an effect at all — see the skill.
9. **Stores update by mutating a draft**: `setStore(draft => { draft.user.name = "Ada" })`.
   Never rebuild with spreads — that destroys property-level subscriptions. The return
   form is for shapes where mutation is awkward — most commonly removal
   (`setTodos((t) => t.filter(...))` is fine; survivors keep identity). Replacing an
   array with a fresh tree replaces rows by index — that is the identity loss; use
   `reconcile` or the derived form (dev + attribution flags the store-level waste as
   `[IMMUTABLE_UPDATE_IN_STORE]`). Stores are
   **property reads** (`todos.length`, `todo.title`), not accessors — never `todos()`.
10. **Async data is an async computation**: `createMemo(async () => ...)` (or
    `createMemo(() => fetchUser(id()))`) read under `<Loading>` / `<Errored>`.
    **Fetch high, block low** — creating/reading are like sync; consuming (await)
    and blocking (the boundary) are independent. Create the memo early, wrap only
    the read with `<Loading>`. Do not glue the boundary to the memo, and do not
    retarget intermediate props to `Promise<User>` / `Accessor<User>` — types stay
    `User`. Nested trees do not suspend: they fetch in parallel; a real waterfall
    looks like `fetchB(a().id)`. JSX component props are lazy (passing isn't reading):
    `<Child user={user()} />` then `{props.user.name}` under the child's
    `<Loading>` is the colorless form. `const u = user()` at the parent *is* a
    read and throws/snapshots there. Pass the memo itself only when the child
    must `refresh()` that source — `isPending(() => props.user)` works on the
    value. Read every reactive input **before the first
    `await`** — post-`await` reads do not subscribe, and in production the computation can
    sit pending with no retry. No `useEffect` + `setState` fetching, no `createResource`.
    `<Loading>` wraps the data slot, not page chrome. After first paint it keeps content
    during refetch (`isPending` for the indicator). Use `on={id()}` (the *value*, not the
    accessor) only when that identity change should show the fallback again. Do not start `fetch` (or any request) at component-body top
    level — that runs once at mount and is not a reactive source. Do not `try/catch` `NotReadyError` around a read, and do not
    use `loadingValue` / `seedLoadingValue` as the default first-flight UI — those skip
    `<Loading>`. `{latest(() => x())}` is a preview, not the visible answer.
    Default navigation holds: keep `selectedId()` so highlight and content stay
    consistent; `latest(selectedId)` only when the highlight should move first.
    Pair `class={{ pending: isPending(selectedId) }}` with a short CSS
    `transition-delay` so fast swaps do not flash. Inputs feeding a request bind
    `value={latest(query)}` so keystrokes show while the write is held.
    `isPending` is a per-expression question, not a global spinner: ask it of the
    async source, a derived prop (`isPending(() => props.story)`), or the write
    (`isPending(selectedId)`), even when the fetch lives in a child. It is
    the *refetch* indicator after a settled answer exists — do not use it as the
    first-load spinner (`<Loading>` owns that). Pass the accessor: `isPending(user)`,
    not `isPending(user())` (that evaluates the read before `isPending` runs).
    Granularity is the expression (`isPending(() => item.quantity)` with
    `affects(item, "quantity")`). A hold with no feedback at all is `[SILENT_HOLD]`
    under attribution — always pair a held write with one of these questions, an
    optimistic value, or `affects()`.
    "Prop with local edits" = writable derivation:
    `createSignal(() => props.value)` or `createStore(() => props.value, fallback)`.
    `createOptimistic` is for an in-flight mutation, not a local editing session.
11. Context: the context object is the provider — `<MyContext value={{ theme, setTheme }}>`
    (no `.Provider`). Pass accessors/setters/stores through context, never snapshot values.
    `createContext<T>()` without a default throws when read outside a provider (good) — use
    that for any reactive payload. `createContext("light")` is only for a primitive static
    fallback; a dummy default on a store/signal context *runs* and then silently no-ops
    without a provider. Truly app-wide singletons (theme, session, locale) are a
    **module-level** signal/store — Context is subtree scoping, not a React-style
    app store. Module state is shared across SSR requests.
12. Refs: `let el!: HTMLDivElement` + `ref={el}` or `ref={(node) => (el = node)}`, or forward
    `props.ref`. Compose with arrays: `ref={[props.ref, (node) => (el = node)]}`. No
    `useRef`/`.current`. Ref callbacks run untracked and **without an owner**; their
    return values are ignored. Do not create effects or register cleanup inside a ref
    callback. For reusable directives, create owned primitives (`onSettled`) in a
    factory and return only the element callback. Component setup/teardown is
    `onSettled(() => { ...; return cleanup })` — `onCleanup` is for custom
    primitives and captured owners, not component bodies. Each `onSettled`
    registers a **single** fire (reads inside are untracked); ongoing
    imperative work is `createEffect`.
13. **Writes are staged** and commit on the next microtask. Event handlers need nothing
    special; tests and imperative integration code must call `flush()` before observing
    updated *synchronous* state or DOM. Waiting on an async memo is
    `await resolve(() => value())` (or Testing Library async queries), not `flush()`.
    Never call `flush()` inside an `action`.
14. Do not port these React tools — they have no Solid equivalent because the problems they
    solve don't exist: `useCallback`, `React.memo`, `forwardRef`, `useSyncExternalStore`,
    dependency arrays, `startTransition`/`useTransition` (updates are held and coordinated
    automatically; use `isPending` for indicators).
15. **Components return once.** Never early-return or conditionally return based on reactive
    values — the branch is chosen once at setup and frozen forever. Put conditionals inside
    JSX (`<Show>`, ternary, `<Switch>`/`<Match>`). Early returns on genuinely non-reactive
    values (build-time config, missing env) are fine. `<Switch>` is first-wins: later
    truthy `<Match>`es are skipped, not “all matching branches”.
16. Prefer `textContent` for text-only content. Use `innerHTML` only for trusted or
    sanitized markup — never interpolate user input into it, never React's
    `dangerouslySetInnerHTML`, and never combine `innerHTML` with JSX children (they fight
    over the same contents).
17. **Never narrow a reactive read with a non-null assertion** (`error()!.message`,
    `user()!`). Use `<Show when={value()}>` with a function child — it passes a
    **narrowed accessor**, so no `!` is needed:
    `<Show when={error()}>{(err) => <p>{err().message}</p>}</Show>`. For non-reactive
    zero-arg calls, use an explicit guard variable instead of `!`.
    Do not add `keyed` by default (the React `key` reflex) — default `Show`/`Match`
    keep children mounted; `keyed` remounts when identity changes.
    Mechanically enforced by `solid2-kit check`.
18. **Never hand-roll async UI state.** No `[loading, setLoading]` signals, no
    `data() === undefined` readiness branches, no `{ data, error }` signal pairs from
    integration layers. Model async as a computation (return a promise or async iterable
    from a memo/store) and let the framework own the states: first load = `<Loading>`
    fallback; refetch indicator = `isPending()`; errors = thrown into the graph and caught
    by `<Errored>`; speculative value = `latest()`. `<Errored>` is graph status, not a
    terminal React ErrorBoundary: it heals when the source succeeds again (refresh,
    live reconnect, input change). `reset` retries the collected *sources*, not a UI
    remount. Per-row mutation failures belong in an errors map the projection folds
    in (survives the optimistic overlay), not in `<Errored>` around the whole list.
    Making a client store "real" is additive: same setters, wrap mutations in
    `action`, swap `createOptimisticStore` and a file of server functions — do
    not rewrite `App.tsx` with loading/error branches.
    No request counters or `AbortController`s for dedup/cancellation — superseded
    answers drop automatically. Throw unusable responses; never `{ success: false }`
    result objects checked at every read.
    Mechanically enforced by `solid2-kit check` (loading-signal naming, zero-arg-call undefined checks).
19. **Refetch is `refresh(source)`** — rarely needed, but when it is, never fake it with a
    counter/version signal read inside the computation. Input-driven refetch is automatic
    (tracked inputs re-run the computation) and subscriptions push. Legit uses: after a
    mutation inside an `action`, and explicit reload buttons. Pair with `affects(source)`
    when the reload should present as pending — a bare `refresh()` re-asks quietly.
    On a derived store, `refresh(store)` re-runs the derivation (`fn`); refreshing a
    plain signal accessor is a no-op. `refresh` returns a promise for the target's next
    settled state (`await refresh(user)`, or `yield refresh(x)` inside an action).
    These are three different APIs: core `refresh(source)` reruns a reactive source;
    router `revalidate(getUser.key)` invalidates the query cache; server-function
    `return reload({ revalidate: "todos" })` asks the integration to refresh cached
    data. Do not mix them.
20. **External collections flow into stores through reconciliation.** First choice:
    function-form `createStore(() => source, fallback)` / `createProjection` (reconcile
    automatically, keyed by `"id"`). Manual merge: `setStore(reconcile(fresh, "id"))` or
    apply `reconcile(fresh, "id")(draft.slot)` inside a draft setter. Plain wholesale
    assignment (`draft.todos = fresh`) renders correctly but notifies every subscriber
    under the path and destroys row identity — same class of problem as unkeyed `<For>`.
21. **Solid inputs do not rewind the DOM.** `value={v()}` writes only when `v` changes; a
    React-style controlled input that ignores invalid keystrokes silently breaks. To reject
    input, write back explicitly:
    `onInput={(e) => { if (valid(e.currentTarget.value)) setV(e.currentTarget.value); else e.currentTarget.value = v(); }}`.
22. Miscellaneous defaults: SSR-stable element ids come from `createUniqueId()` (never
    `Math.random()` or hardcoded duplicates); pass store data to `structuredClone` /
    `postMessage` / logs via `snapshot(store)` (proxies fail or leak reactivity); render
    modals/tooltips/overlays through `<Portal>` from `@solidjs/web`; mutations whose writes
    cross an async gap default to `action` + `createOptimistic`/`createOptimisticStore` —
    the sync mutation *is* the prediction (an overlay, discarded on settle); write the
    body as a generator (`function*` / `async function*`) suspending on `yield`, never a
    plain `async` function (`solid2-kit check` flags that); put
    `pending` on the record rather than a second copy of state. Do not snapshot
    and restore, disable optimistic rows until ack, mutex rapid clicks, or freeze
    unrelated writes because one action is in flight; failed-action replay is
    optional. Fire-and-forget confirmations wait with `yield until(predicate,
    { timeout })` — the predicate reads authoritative state. Except reactive clients (e.g. Convex) whose subscriptions already push authoritative
    state after mutations. Compiler: `"jsxImportSource": "@solidjs/web"` (not `"solid-js"`);
    Vite plugin is `@solidjs/vite-plugin` (not `vite-plugin-solid`) — run `solid2-kit doctor`
    after touching `package.json` / tsconfig / root configs; it fails on React and Solid 1.x
    wiring. Server vs browser:
    `isServer` / `isDev` from `@solidjs/web`, or `clientOnly(() => import("./Widget"))` for
    browser-only components — never `typeof window` as the SSR boundary. Default
    `clientOnly` starts loading at declaration; `{ lazy: true }` defers until first
    render. `NoHydration` / `Hydration` split hydration *ownership*; they do not choose
    visible content — `clientOnly` is for components that must never run on the server.
    A single browser-only *value* takes `ssrSource` on the memo/signal/derived store
    (`"client"` skips the server value and computes after hydration, e.g. `localStorage`;
    `"hybrid"` re-runs after adopting the serialized value, e.g. window size mixed with
    server data) — do not split a component via `clientOnly` for one value. An
    `onSettled` fill-in remains a valid alternative.
    Pass a **function** to `render` / `hydrate` / `renderToString` / `renderToStream`
    (`render(() => <App />, root)`), never `render(<App />, root)`. `hydrate` when the
    container already holds SSR HTML; `render` for an empty mount. Client mode (the
    `@solidjs/vite-plugin` default) mounts with `render()` into an empty body — there is
    **no server HTML and no hydration mismatch**, so React's mismatch defenses
    ("server-safe" initial values adopted after mount, two-pass rendering) are unnecessary
    and can clobber persisted state; read `localStorage` / `matchMedia` directly when
    creating the signal. `renderToString`
    emits `<Loading>` fallbacks; async or lazy-route trees need
    `await renderToStream(() => <App />)` (one consumer: `pipe` / `pipeTo` / `readable`).
    When the app owns the document, emit `<HydrationScript />` once before app markup;
    extra roots get a distinct `renderId`. Import `GET` from
    `@solidjs/web/server-functions`, never `@solidjs/start`. `httpStatus` /
    `httpHeader` are scope *declarations* (call them bare in a component or
    fallback body), not event-time mutations. `JSON.stringify(store)`
    / `structuredClone(store)` without `snapshot(store)` can throw or leak proxies. Async SSR
    without `<Loading>` *works* but blocks the HTML shell until every read settles — wrap
    reads, or stream with `renderToStream`. `pipe` / `pipeTo` / `readable` each consume
    a stream render — use exactly one. `createRoot` is for tests, libraries, and
    non-render entry points; inside a component let `render` / the component owner
    own the scope. Async reads inside `<Portal>` start on the client — hoist the
    read above the portal. Navigation-shaped updates (a setter, then async computeds holding previous values)
    do not need core `action` — reach for it only when writes happen *after* async work.
    Invoke actions from handlers, not from memos or effects.
23. **Composition.** Pass `props.children` through when you only render them. Inspect or
    iterate children with `children(() => props.children)` (then `.toArray()`), never a
    setup-time snapshot. Code-split with `lazy(() => import("./X"))` under `<Loading>` —
    not `React.lazy` / `<Suspense>`. Named exports: `lazy(() => import("./pages"), { export: "About" })`
    — `lazy(() => import("./pages").then((m) => ({ default: m.About })))` hydrates wrong
    because the named export is not a call-site literal. Select a component from reactive
    state with `dynamic(() => ...)` from `@solidjs/web`
    (stable identity). If the project has `@solidjs/router`, routes are `createRouter({ routes })`
    at module scope — not JSX `<Route>` / `<A>` / `<HashRouter>`. That package's `action` /
    `query` are URL-addressable POST forms and a read cache — not core `action` /
    `refresh` from `solid-js`. Router mutations: `<form action={save} method="post">`
    (POST only; `.with(id)` binds args into the URL). Validate on the server
    (`throw respond({ issues }, { status: 400 })`); inline errors from `useSubmissions`,
    pending via `form[aria-busy]` CSS. Keep server functions in `src/data/`, not under
    `src/routes` (a `.ts` file there is an API route). `useAction` is JS-only. Cache
    reads: `query(fn, "name")` then `createMemo(() => getUser(id()))`; after a mutation
    `revalidate(getUser.key)`. Do not wrap mutations in `query` (an undeclared server
    function becomes GET). `Router.paths` is not the current location (`useLocation` /
    `useParams`); search params via `useSearchParams` (merging setter; typed with a route
    `search` schema + path node). A route `preload` result is `props.data`. One router instance —
    Solid Router does not support nested `<Router>` / nested `createRouter`.
    In-app navigation is `useNavigate` or `<a href={Router.paths...}>`, not
    `window.location` / `history.pushState`. Link state is automatic
    (`aria-current` / `data-active` / `data-pending` + CSS; `useLinkState` /
    `useIsRouting` in JSX) — never hand-rolled `location.pathname` comparisons. Trusted identity is
    `getRequestEvent()`, never a caller-supplied user id. Unscripted forms use
    the function `.url` (or a router `action`), not a hand-built `/_server/`
    path. Client history adapters do not select the SSR URL — pass
    `<Router url={request.url}>` (or rely on the request event). Secrets belong in
    `virtual:env/server`, never the `client` env map / `import.meta.env`. Document head is
    `<Title>` / `<Meta>` from `@solidjs/meta` with **no** `MetaProvider`. A static
    `<title>` in the document shell is the fallback; do not hardcode other tags
    (`<meta name="description">`) that Solid Meta should manage.
    Return `respond(value, { status, headers })` from a `"use server"` function, not
    `Response.json` — a raw `Response` is HTTP-handler control flow; scripted
    callers should receive the value. Reads are function calls too (`await getUser(id)`
    on a `GET()`-declared read; the method mirrors the operation). Return or throw a
    redirect (`if (!session?.userId) throw redirect("/sign-in")`); `redirect()` /
    `respond()` take `revalidate` like `reload()`. Cache GET reads with
    `Cache-Control` on that response (the default is `no-store`), not a hand-rolled
    Solid cache. HTTP does not enforce TypeScript —
    validate inside the function; do not invent tRPC / RPC type-gen.
    Locals only the `"use server"` body reads (db, secrets) stay off the client.
    Do not add an API-route file just to wrap a database call — `"use server"`
    is the RPC. During SSR the call is in-process (no HTTP). After a mutation, `reload` /
    `revalidate` / single-flight — never a client `fetch` or an `onSettled` /
    `hydrate` refetch to "refresh the page". In-flight Promises serialize as
    Promises; `live()` embeds the first value in HTML and continues the stream on
    the client. Do not delay `renderToStream` for visual order (`<Reveal>` owns
    display). Do not write subscribe/unsubscribe in the component around `live()`.
    When the app has a server bundle (`ssr` or server functions), production is
    `handleRequest(request)` from the built `dist/server/server.js` (or its
    Fetchable `fetch`); platform Vite plugins adopt that handler (Node: the
    template `server.js`). Client-only start mode is static `dist/client` —
    there is no handler to wrap. Request middleware is
    `start: { middleware: "./src/middleware.ts" }`, not Express `app.use`. Do not return
    components from `"use server"` unless the project already enabled the
    experimental `serverFunctions.components` flag. JSON-encodable server-function arguments
    only, unless `enableRichArguments()` was called once in the client entry
    (`Date` / `Map` / `Set` throw without it). `live()` connection state is
    `source.onstatus` (`"connected"` / `"reconnecting"` / `"closed"`), never a
    field in the yielded value. Sibling `<Loading>` reveal order is `<Reveal>`
    (`collapsed` suppresses tail skeletons under sequential order).

## Lint heritage: eslint-plugin-solid (Solid 1.x) intents carried into this file

`eslint-plugin-solid` targets Solid 1.x. **Do not install it** — its analyzer predates the
Solid 2 model and misreads two-phase `createEffect`, writable derivations
(`createSignal(fn)`), and draft setters as errors. Its still-valid intents are enforced here
instead, and `solid2-kit check` checks the mechanically detectable ones on the source
directory (default `src/`).

| 1.x lint rule | Status in Solid 2 | Where |
|---|---|---|
| `solid/no-destructure` | still critical | rule 1 + `solid2-kit check` |
| `solid/reactivity` | still critical | rules 2–3 (+ Solid 2 dev-mode warnings) |
| `solid/components-return-once` | still valid | rule 15 |
| `solid/no-react-specific-props` | still valid | rule 5 + `solid2-kit check` |
| `solid/no-react-deps` | still valid — never pass React-style dependency arrays | rule 8 + `solid2-kit check` react-hook check |
| `solid/prefer-for` | still valid — `{list().map}` still renders | rule 7 + `solid2-kit check` |
| `solid/prefer-show` | now a recommended default when narrowing | rule 17 + `solid2-kit check` |
| `solid/no-innerhtml` | still valid | rule 16 |
| `solid/style-prop` | still valid | rule 5 + `solid2-kit check` |
| `solid/imports` | changed paths | banned-API table + `solid2-kit check` |
| `solid/event-handlers` | still valid | rule 6 |
| `solid/jsx-no-undef`, `jsx-no-duplicate-props` | covered by TypeScript | project typecheck |
| `solid/prefer-classlist` | obsolete — `classList` removed | `solid2-kit check` bans `classList` |
| `solid/no-unknown-namespaces` | obsolete — `on:`/`use:`/`attr:` removed in 2.0 | banned-API table + `solid2-kit check` |
| `solid/no-proxy-apis` | obsolete — Solid 2 requires Proxy | not carried |

## Banned Solid 1.x APIs (Solid 2 replacements)

| Never write (Solid 1.x) | Write instead (Solid 2) |
|---|---|
| `import ... from "solid-js/store"` or `"solid-js/web"` | stores/`merge`/`omit` from `"solid-js"`; `render`/`hydrate`/`Portal`/`Dynamic` from `"@solidjs/web"` |
| `import type { JSX } from "solid-js"` / `JSX.Element` as the children type | `solid-js` exports no `JSX` namespace: children/returns are `Element` from `"solid-js"`; DOM-specific `JSX` types (`JSX.IntrinsicElements`, `JSX.CSSProperties`) from `"@solidjs/web"` |
| `createResource` | async `createMemo` + `<Loading>`/`<Errored>`; `refresh()`, `latest()`, `isPending()` |
| `createEffect(fn)` (one arg), `on(...)` | `createEffect(compute, apply)`; deps belong in `compute` |
| `onMount` | `onSettled` (return cleanup from its callback) |
| `batch(...)` | delete it — writes auto-batch; `flush()` only to observe synchronously |
| `<Suspense>`, `<ErrorBoundary>`, `<SuspenseList>` | `<Loading>`, `<Errored>` (fallback gets an error *accessor*), `<Reveal>` |
| `<Index>` | `<For keyed={false}>` |
| `<Ctx.Provider value={...}>` | `<Ctx value={...}>` |
| `setState("a", "b", value)` path setters, `produce(...)` | draft setter: `setState(draft => { ... })` |
| `mergeProps` / `splitProps` / `unwrap` | `merge` / `omit` / `snapshot` |
| `classList={...}` | `class` object/array form |
| `createMutable`, `modifyMutable` | `createStore` + draft setters |
| `createComputed`, `createSelector`, `createDeferred` | `createMemo`, `createProjection`, external scheduling |
| `startTransition`, `useTransition` | automatic held updates + `isPending` |
| `onError` / `catchError` | `<Errored>` or effect bundle `{ effect, error }` |
| `from(...)` / `observable(...)` (the solid-js helpers) | inbound: async iterable from a memo; outbound: split effect |
| `createDynamic(...)` | `dynamic(source)` from `@solidjs/web` |
| `renderToStringAsync(...)` | `await renderToStream(() => <App />)` (one consumer: `pipe` / `pipeTo` / `readable`) |
| `clearDelegatedEvents` | delete — delegated listeners are scoped to each render root |
| `vite-plugin-solid` / `jsxImportSource: "solid-js"` | `@solidjs/vite-plugin` / `"jsxImportSource": "@solidjs/web"` |
| JSX `<Route>` / `<A>` / `<HashRouter>` / `<Navigate>` / `<FileRoutes>` | `createRouter({ routes })`, `fileRoutes(pageRoutes)` (`fileRoutes` from `@solidjs/router/fs`, `pageRoutes` from `virtual:file-routes`), plain `<a href={Router.paths...}>`, `hashHistory()`; link state via automatic `aria-current` / `data-active` / `data-pending` + CSS (`useLinkState` in JSX) |
| `createAsync` / `createAsyncStore` / `useSubmission` / router `json()` / `cache()` | `createMemo(() => getUser(id()))`, `useSubmissions`, `respond()` from `@solidjs/web`, `query` |
| `import ... from "@solidjs/start"` / `vinxi` / `h3` / `"use client"` | `GET` from `@solidjs/web/server-functions`; Solid has no `"use client"` |
| `render(<App />, root)` | `render(() => <App />, root)` (same for `hydrate` / `renderToString` / `renderToStream`) |
| `<MetaProvider>` | no provider — render `<Title>` / `<Meta>` / `<Link>` from `@solidjs/meta` anywhere |
| `use:directive`, `on:`/`oncapture:`, `attr:`/`bool:`, `/*@once*/` | `ref` callbacks, camelCase event props, standard attributes, keep values reactive |
| `resource.loading` / `resource.error` | `<Loading>` boundary / `<Errored>` boundary |

When unsure about any API, verify against the official Solid 2.0 docs — fetchable URLs are
listed in `references/official-docs.md` next to the `solid-2` skill. Do not guess from
Solid 1.x or React memory.

`createTrackedEffect`, `createRenderEffect`, and `storePath` exist in Solid 2 but
are not defaults: use two-phase `createEffect` unless a single tracked callback is
required, and draft setters instead of `storePath` except while converting 1.x
path setters.

<!-- solid2-agent-kit:solid-rules:end -->

<!-- fallow:agent-install v1 claude-import:start -->
@AGENTS.md
<!-- fallow:agent-install v1 claude-import:end -->

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
