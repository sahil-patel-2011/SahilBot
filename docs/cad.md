# CAD in SahilBot

"Go build this inside of CAD" is agent work. SahilBot designs the part before it models it, builds it in
Onshape (through the user's API keys) or FreeCAD (on this Mac), checks the result, and reports back.

## How a request is heard

- `src/main/cad/cad-intent.ts` reads the request. `CAD_RE` matches CAD words: the tools, file types,
  features, mechanical parts and processes. Ambiguous words like "shell", "brackets" and "housing" only
  count inside clearly mechanical phrases. `cadSignals(text)` returns `{ cad, build, assembly, effort }`:
  `effort` is `high` for a part and `xhigh` for a whole assembly or mechanism.
- `src/main/agent/intent.ts` has a CAD group, `cad_design`, `onshape` and `freecad`, that loads up front
  for CAD requests. `freecad` loads only when FreeCAD is installed. The group is left out of Claude's
  preloaded `likelyTools` set because the schemas are large.
- `src/main/agent/loop.ts` has a one-line guard: a CAD build request never takes the lean chat path.
  It can be removed once the chat-or-agent classifier sends CAD builds to the agent path itself.
- Backend: Onshape when its keys are saved, else FreeCAD if it is installed. Otherwise SahilBot explains
  the one-time setup (`SETUP_TEXT` in `workflow.ts`).

## The design workflow (`cad_design` tool, `src/main/cad/design-tool.ts`)

| Action | What it does | Progress card |
|---|---|---|
| `brief` | Restates the requirements: dimensions and units, loads, material, process, tolerances and fits, interfaces, standards, constraints and assumptions. It lists what is still missing and what to research. Sources are cited. | Design brief |
| `concepts` | Takes 2-4 distinct concepts scored on strength, weight, manufacturability, cost and assembly, and records the recommended one. `confirm: true` asks a user who is watching. Unattended runs use the recommendation. | Concepts |
| `plan` | Checks the feature plan (`src/main/cad/plan.ts`): variables, features, assembly and mates, and the measurements it must hit. | Plan |
| `build` | Builds the plan in Onshape (`onshape-build.ts`) or FreeCAD (`freecad-build.ts`). | Build |
| `verify` | Checks size, volume, feature errors, interference and clearance. It also returns pictures for the model to look at: Onshape shaded views, or FreeCAD wireframes drawn by `wire-png.ts`. | Verify |
| `deliver` | Writes the summary: parameters, checks, link, files, and STEP/STL exports. | all done |

Each result carries `meta.plan` and `meta.planTitle: 'Design'`. The chat's existing plan card
(`ThreadView.tsx`) and the Progress pane (`RightPanel.tsx`) show it as "Design brief → Concepts → Plan →
Build → Verify". The same items go into `state.todos`.

The skill `packs/skills/cad-design-workflow` covers the agent's side: what to ask, what to research,
design rules of thumb, and when to stop iterating.

## Onshape (`src/main/agent/tools/onshape.ts`, `src/main/cad/onshape-*.ts`)

All endpoints are in the v17 OpenAPI spec (https://cad.onshape.com/api/openapi, the explorer at
https://cad.onshape.com/glassworks/explorer/).

| Capability | Endpoint (operationId) | Docs |
|---|---|---|
| New document | `POST /documents` (createDocument) | https://onshape-public.github.io/docs/api-adv/documents/ |
| New tab | `POST /partstudios/d/{did}/w/{wid}`, `/assemblies/…`, `/variables/d/{did}/w/{wid}/variablestudio`, `/featurestudios/…` | explorer |
| Feature specs (parameter ids, enum names and options) | `GET /partstudios/…/featurespecs` | explorer |
| Add / update / delete feature | `POST …/features`, `POST …/features/featureid/{fid}`, `DELETE …/features/featureid/{fid}` | https://onshape-public.github.io/docs/api-adv/featureaccess/ |
| Sketches with constraints | `BTMSketch-151` with `BTMSketchCurveSegment-155` / `BTMSketchCurve-4` entities and `BTMSketchConstraint-2` (types from `GBTConstraintType`) | featureaccess + OpenAPI schemas |
| Extrude, revolve, fillet, chamfer, shell, hole (sketch + cut), linear/circular pattern, mirror, cube, variables (`assignVariable`) | feature JSON. Parameter ids follow the FeatureScript library (https://cad.onshape.com/FsDoc/library.html) and are checked against featurespecs before sending | FsDoc |
| Assembly instances, placement, mates | `POST …/instances`, `POST …/occurrencetransforms`, `POST /assemblies/…/features` (`BTMMateConnector-66`, `BTMMate-64`) | https://onshape-public.github.io/docs/api-adv/assemblies/ |
| Custom FeatureScript | `POST /featurestudios/d/{did}/w/{wid}`, `GET/POST /featurestudios/…/e/{eid}` (contents) | explorer |
| Interference and clearance | `POST …/featurescript` with a read-only lambda using `evCollision` and `evDistance` | https://onshape-public.github.io/docs/api-adv/fs/, FsDoc |
| Mass properties, bounding box, shaded views, STEP/STL export | already present: `massproperties`, `boundingboxes`, `shadedviews` (now several views), `translations` | https://onshape-public.github.io/docs/api-adv/translation/ |

How the build works:

- Features refer to earlier ones by featureId through FeatureScript query strings, in the documented
  `query=…;` form. Examples: `qCreatedBy(makeId("F1"), EntityType.EDGE)` and `qCapEntity(…, CapType.END, …)`.
- Sketch regions use `filterInnerLoops: true`, so a circle drawn inside a rectangle stays a hole.
- Patterns along X, Y or Z first get a sketch with one line along that axis, then select its edge
  (`sketchEntityQuery`).
- If Onshape rejects a sketch's constraints, the sketch is sent again without them, and the result says
  so.
- The build stops at the first feature that doesn't regenerate. A rebuild updates the features it made
  earlier, in place. Nothing is ever deleted by the build.

Approvals:

- A new document, and changes inside a document made this session (`src/main/cad/created.ts`), are
  routine, so Auto runs them.
- Changes to the user's existing documents always ask.
- `delete_feature` is destructive and a hard stop in the user's documents.
- Replacing a Feature Studio's code in the user's documents is destructive and a hard stop.

## FreeCAD (`src/main/cad/freecad-build.ts`)

- The plan is compiled to JSON with every dimension in mm.
- One fixed Python interpreter (`PY_BUILD`) runs it under `freecadcmd` using the Part workbench: makeBox,
  extrude and revolve of sketch faces, makeFillet, makeChamfer, makeThickness, boolean fuse/cut/common,
  patterns and mirror. The plan only ever reaches Python through `ARGS_JSON`, never as Python source.
- Output goes to a new folder under `exports/freecad`: an `.FCStd` file with a Parameters spreadsheet,
  plus `.step` and `.stl`. Existing files are never overwritten.
- It measures the bounding box, volume, validity, pairwise interference and the smallest gap.
- `freecadcmd` has no GUI, so the model's edges are returned as polylines and drawn as wireframe PNGs.

## Tests

- `tests/unit/cad-workflow.test.ts` covers:
  - listening, the intent group and the workflow steps;
  - concept prompts and checks;
  - plan → feature JSON mapping and the spec check;
  - builds, rebuilds, constraint fallback, assemblies and mates against the fake server;
  - every new onshape action;
  - approvals (Auto / Autonomous verdicts, destructive ops, hard stops);
  - FreeCAD compile, script syntax (`python3 -I` ast parse), the build with a stubbed runner, and wireframes.
- `tests/fixtures/fake-onshape.ts` is a stateful fake. It checks every HMAC signature, keeps
  documents, tabs and features, returns featurespecs in the OpenAPI shape, and computes the cube and
  fillet geometry.
- `tests/accept/cad.test.ts`: "build a 40 mm cube with a 5 mm fillet in CAD", hidden, with a mock model.
  The CAD tools load without `find_tools`. The workflow runs against the fake server. The Design card
  ends with all five steps done, the STEP file lands in the workspace, and no approval card appears.
  The test passes the fake through `FOREMAN_ONSHAPE_URL`, which only dev builds honor.

## Limits

- No real Onshape or FreeCAD runs were made. FreeCAD isn't installed on the dev Mac, so the Python
  interpreter has been checked for syntax only.
- These parameter ids are not in Onshape's docs and rely on the featurespecs check at build time:
  - Feature-level parameters for revolve (`revolveType`, `angle`), shell and mirror (`mirrorPlane`, with
    aliases).
  - Sketch constraint parameters (`localFirst`, `localSecond`, `length`). These fall back to sending
    the sketch unconstrained.
- Onshape's REST API has no assembly interference check. Clashes are checked between Part Studio
  bodies.
- On free and education plans, each build and verify costs about 10-15 of the 2,500 API calls a year.
