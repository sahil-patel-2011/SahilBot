---
name: game-roblox
description: Build a complete, playable Roblox game (Luau, Rojo project), split into systems that parallel helpers build at once, then integrated and checked.
source: builtin
uses: 0
category: Coding
triggers: roblox, roblox game, roblox studio, luau, rojo, obby, tycoon, simulator game, tower defense game, roblox experience
---

Goal: a game someone can open in Roblox Studio and play start to finish, not a sketch. Work as a team when the game has more than two systems (Auto may already have set up parallel helpers).

1. Design in a few lines first (write it to `DESIGN.md`): genre and core loop (what the player does every 30 seconds), win/lose or progression, the systems needed, and the controls. Pick sensible defaults instead of asking.
2. Project skeleton (you, before any helper starts), a Rojo project:
   - `default.project.json` mapping `src/server` → ServerScriptService, `src/client` → StarterPlayer.StarterPlayerScripts, `src/shared` → ReplicatedStorage.Shared, `src/ui` → StarterGui.
   - `src/shared/Config.luau` (every tunable number in one place), `src/shared/Remotes.luau` (every RemoteEvent / RemoteFunction created in one place, by name), `src/shared/Types.luau`.
   - `--!strict` at the top of every file; ModuleScripts return one table; no globals.
3. Split into systems, one owner each (no two helpers edit the same file). Typical parts:
   - Rounds / game loop (server): lobby → intermission → play → results, using Config timings.
   - Player data (server): DataStoreService with `pcall`, retries with backoff, session locking (UpdateAsync), save on PlayerRemoving and `game:BindToClose`, a default profile and versioned migrations.
   - Gameplay mechanics (server + client): the core actions (combat, collecting, building…), cooldowns, hit validation on the server.
   - Economy / shop / leaderstats (server), with prices from Config.
   - UI (client, `src/ui` + `src/client`): HUD, shop, round timer, results; scale with UIScale/UIAspectRatioConstraint so it works on phone and PC.
   - World (server or a builder script): the map, spawn points, obstacles or NPC paths built from code (Instance.new / parts with names and anchoring), so the game works without hand-made assets.
   - NPCs / enemies if the genre needs them: PathfindingService, a simple state machine.
   Give each helper: the files it owns, the Remotes and Config keys it may use (from step 2), what done means and how to check it.
4. Security (non-negotiable): the client only asks; the server decides. Validate every RemoteEvent argument on the server (type, range, distance, cooldown, ownership); never trust client-sent damage, currency or positions; rate-limit remotes.
5. Integrate (you): read every helper's files, wire the systems together in `src/server/Main.server.luau` and `src/client/Main.client.luau`, make Remotes and Config names match, remove duplicates.
6. Check before calling it done:
   - `rojo build -o game.rbxlx` builds without errors (install Rojo with the user's OK if missing; or `aftman`/`rokit`).
   - Lint: `selene src` and format with `stylua src` when available.
   - Read through the whole loop once as a player would: join → play a round → earn/progress → leave and rejoin (data saved).
   - If the Roblox Studio MCP connector is connected, open the place, run a playtest and read the Output for errors; fix them.
7. Report: what the game is and how to play it, how to open it (`game.rbxlx` in Roblox Studio, or `rojo serve` + the Rojo plugin), what each system does, and what's worth adding next.

Gotchas:
- `wait()` is deprecated: use `task.wait`, `task.spawn`, `task.delay`.
- DataStores need "Enable Studio Access to API Services" (Game Settings → Security) to save in Studio; say so.
- Don't put RemoteEvents in scripts that run on both sides; create them once in Remotes.luau on the server and fetch with WaitForChild on the client.
- Avoid `while true do` loops without `task.wait`; prefer events (Heartbeat, Touched, PropertyChangedSignal).
