---
name: new-web-app
description: Create and run a new web app (React + Vite + TypeScript) from scratch.
source: you
uses: 0
category: Coding
---

1. Pick the folder: inside the workspace or an attached folder. `run_command`: `npm create vite@latest <name> -- --template react-ts` (needs approval: it downloads).
2. `cd <name> && npm install`, then `npm run build` to prove it compiles.
3. Build the requested features in small steps; after each, run `npx tsc --noEmit` and `npm run build`.
4. To look at it: start the dev server in the background (`npm run dev -- --port 5173 > dev.log 2>&1 &`), open http://localhost:5173 with the browser tool, snapshot it, and click through the main flows.
5. Fix every console error (browser snapshot + `cat dev.log`).
6. Finish with: where the project is, how to run it, and what's left.
