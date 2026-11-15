---
name: react-frontend
description: Build or fix React components - hooks rules, state placement, effect bugs, keys, forms, data fetching, Testing Library and a11y in Vite apps.
source: you
uses: 0
category: Coding
triggers: react component, usestate, useeffect, react hooks, jsx, tsx component, vite react, react testing library, infinite re-render, stale closure, strictmode double render, missing key prop, usememo usecallback, controlled input, tanstack query
---

## When
Any React UI (Vite, Next.js, CRA leftovers). Read typescript-project for tsc/eslint/vitest basics, new-web-app to scaffold, playwright-testing for end-to-end checks.

## Tooling
- Vite: npm run dev (port 5173), npm run build (runs tsc -b first in the TS template), npm run preview. Next.js: next dev / next build.
- Lint with eslint-plugin-react-hooks enabled; its exhaustive-deps warnings are real bugs more often than not.
- Tests: vitest + @testing-library/react + @testing-library/user-event, environment jsdom. One test: npx vitest run src/Cart.test.tsx -t "adds item".

## Layout
src/components (presentational), src/features/<area> (components + hooks + api per feature), src/hooks, src/lib (pure helpers). One component per file, named export, colocated test.

## Rules
1. Hooks only at the top level of components or custom hooks, never in conditions, loops or after an early return.
2. Render must be pure: no fetches, subscriptions, DOM writes or mutation of props/state during render.
3. State placement: keep it in the lowest component that needs it; lift to the common parent when siblings share it; Context for app-wide values that change rarely (theme, user); URL for anything that should survive reload or be linkable. Don't store what you can compute from props or state.
4. Update immutably: setItems(prev => [...prev, item]). Use the updater form whenever new state depends on old.
5. Keys: stable ids from the data. Index keys break when the list is reordered, filtered or has inputs; random keys remount every render.
6. Memoize (memo, useMemo, useCallback) only after the Profiler shows a slow render or a child depends on referential identity. The React Compiler, if enabled, does this for you.

## Effects
- First ask whether you need one: derived values go in render, event-driven work goes in the handler. Effects are for syncing with something outside React.
- Deps list every reactive value used inside; don't silence the lint rule. Objects/functions created in render change every time: move them inside the effect or memoize.
- Stale closure: an interval or listener reads an old value. Use the updater form or a ref holding the latest value.
- Return a cleanup that undoes the setup. StrictMode in dev mounts, unmounts and remounts once on purpose; if that breaks things, the cleanup is missing.
- Fetch in an effect needs an AbortController or ignore flag to prevent races. Prefer TanStack Query, SWR, or the framework loader for server data (cache, retries, loading and error states).

## Forms
Controlled inputs (value + onChange) for small forms; react-hook-form plus zod for large ones. Always a label tied to the input, preventDefault in onSubmit, disable the button while submitting, show server errors.

## Accessibility
Use real elements (button, a, label, nav). Every image needs alt; icon buttons need aria-label. Keyboard must reach and operate everything; keep focus visible; move focus into opened dialogs and back on close.

## Testing
Query like a user: getByRole("button", { name: /save/i }), getByLabelText. Use findBy for async and await userEvent actions. No implementation details (state, class names). Mock the network (msw) rather than hooks.

## Pitfalls
- {count && <X/>} renders 0; use count > 0.
- Calling setState during render causes an infinite loop; onClick={fn()} calls it immediately.
- Mutating an array then setting it: same reference, no re-render.
- Effects that set state from props instead of using a key to reset.

## Verify
typecheck, lint (hooks rules clean), targeted vitest, npm run build, then open the page (preview tools or playwright) and check the console for errors and key warnings.

## Example
```tsx
useEffect(() => {
  const ctrl = new AbortController();
  fetch(`/api/users/${id}`, { signal: ctrl.signal }).then(r => r.json()).then(setUser).catch(() => {});
  return () => ctrl.abort();
}, [id]);
```
