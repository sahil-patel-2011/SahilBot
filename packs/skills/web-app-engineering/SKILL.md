---
name: web-app-engineering
description: Builds production web apps in Next.js or Vite - rendering and caching, auth, forms, accessibility, Core Web Vitals and client-side secrets.
source: you
uses: 0
category: Coding
triggers: next.js, app router, server component, use client directive, server actions, vite spa, core web vitals, lcp inp cls, httponly cookie, oauth oidc login, session vs jwt, form validation zod, aria label, wcag contrast, next_public env, bundle size budget
---

## When
Feature work or review on a web app. Scaffolding: read new-web-app. React component patterns: react-frontend.

## Steps
1. code(action="project"): framework and version (package.json `next`, `vite`), router type (`app/` vs `pages/`), auth library, test runner. Version matters: Next caching defaults changed across majors, so check the installed version's docs before assuming.
2. Decide where each piece runs before writing it (rules below).
3. Implement the smallest vertical slice: route, data fetch, UI, one test.
4. Run typecheck, lint, tests, then `next build` / `vite build` and read the route size table.

## Next.js App Router rules
- Components are server components by default. Add `"use client"` only for state, effects, event handlers or browser APIs, and push it to the leaf. A client component cannot import a server-only module; pass server data down as props.
- Fetch data in server components or route handlers, not in useEffect. Mark DB/secret modules with `import "server-only"`.
- Caching: know whether a fetch is static, revalidated (`revalidate: N`) or dynamic (reading cookies/headers makes the route dynamic). After a mutation call `revalidatePath`/`revalidateTag`; stale data after a write almost always means a missing revalidate.
- Server actions are public endpoints: validate input and check auth inside every one.
- Vite SPA: everything ships to the browser. All authorization lives on the API; route guards are UX only.

## Auth
- Sessions (opaque id in a cookie, state on the server) are the default for first-party web apps: easy revocation. JWTs suit stateless service-to-service calls; if you use them for browsers, keep them short-lived with a refresh flow.
- Cookies: `HttpOnly; Secure; SameSite=Lax` (Strict where possible). Never put tokens in localStorage. Add CSRF protection for cookie-authenticated mutations unless SameSite covers it.
- OAuth/OIDC through a maintained library (Auth.js, Lucia-style helpers, the provider SDK), with PKCE and state. Never write your own crypto, password hashing (use argon2/bcrypt), or token signing.

## Forms
- Validate on the client for feedback and on the server for truth, sharing one schema (zod/valibot).
- Progressive enhancement: a real `<form action>` that works without JS; disable the submit while pending; show field-level errors linked with `aria-describedby`.

## Accessibility checklist
- Semantic elements (`button`, `a href`, `nav`, `main`, headings in order) before ARIA.
- Every input has a `<label>`; icon buttons have `aria-label`.
- Visible focus ring; dialogs trap and restore focus; everything works by keyboard (Tab, Enter, Space, Esc).
- Text contrast >= 4.5:1 (3:1 for large text); never color-only status.

## Performance budgets
- Targets at p75: LCP < 2.5 s, INP < 200 ms, CLS < 0.1.
- LCP: preload/prioritize the hero image, serve AVIF/WebP at the right size (`next/image`), avoid client-only rendering of above-the-fold content.
- INP: keep main-thread tasks < 50 ms; split heavy components with dynamic import; debounce input handlers.
- CLS: set width/height or aspect-ratio on media; reserve space for ads/embeds; use `font-display: swap` with size-adjusted fallbacks.
- Budget the JS: e.g. < 170 KB gzipped initial per route. Check with the build output or a bundle analyzer before adding a dependency.

## Env vars and secrets
- Anything prefixed `NEXT_PUBLIC_` or `VITE_` is inlined into the bundle and public. Secrets stay server-side with no prefix.
- Verify: search the built output, e.g. `grep -r "sk_live" .next/static dist/` should return nothing.

## Pitfalls
- `"use client"` at the layout root turns the whole tree into client JS.
- Hydration mismatch from `Date.now()` or locale formatting during render.
- Trusting middleware alone for auth; check again in the handler.

## Verify
Build passes; Lighthouse or the web-vitals library on the changed page; keyboard-only walkthrough; a test that a protected route returns 401/redirect when logged out.
