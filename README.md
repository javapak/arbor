# arbor

A small, LLM-friendly meta-modeling language for software models, built on
[Langium](https://langium.org) (TypeScript, runs in Node and in a browser web
worker, no JVM), with an intermediate representation (IR) as the hub between
the text and everything else, including the WebGPU flow renderer.

```
 .arbor text ──► Langium AST ──► IR (JSON) ──► flow graph   (renderer)
 (profiles +    (packages/      (packages/ir) ──► JSON Schema / OpenAPI / DDL …   (future emitters)
  models)        language)        ▲
                                  └── importers (Ecore, OAS, …)                  (future)
```

**The rule that keeps this maintainable:** nothing converts directly to anything
else. Importers produce the IR, emitters consume it, and only `ast-to-ir.ts`
knows about both Langium and the IR.

## Layers

| OMG | Here | Where |
|---|---|---|
| M3 (MOF) | the grammar: `kind`, `prop`, `contains`, `ref`, `enum`, `visual` | `packages/language/src/language/arbor.langium` |
| M2 | **profiles**, as plain data, loaded at runtime | `examples/software.arbor`, `examples/persistence.arbor` |
| M1 | **models** in one generic instance syntax | `examples/shop.arbor` |

Profiles are interpreted, never compiled: users can define new kinds at
runtime with no TypeScript compiler API and no `eval`.

## Packages

| Package | Depends on | Purpose |
|---|---|---|
| `@arbor/ir` | nothing | IR types, JSON Schema, `IRIndex` read helpers (inheritance, defaults, visuals), and the renderer-neutral visual vocabulary (`VISUAL_KEYS`) |
| `@arbor/adapter-flow` | `@arbor/ir` | IR → `{ nodes, edges }` for the renderer, with layout from a sidecar |
| `@arbor/language` | Langium, the two above | grammar, validator, AST → IR, CLI, LSP entry points (Node + web worker), diagram requests (`src/lsp/`) |
| `@arbor/property-form` | `@arbor/ir`, React, Mantine | a form for one element's slots, drawn from the JSON Schema `slotSchema` derives from its kind |

## Getting started

```bash
npm install
npm test            # langium generate + tsc + vitest
npm run check -- examples/*.arbor
npm run ir    -- examples/*.arbor
npm run flow  -- examples/*.arbor
```

`check` prints one JSON diagnostic per line, each with a stable code and,
where possible, a `fix`. See [docs/LANGUAGE.md](docs/LANGUAGE.md), which is
also written to be pasted into an LLM prompt.

## No eval, enforced three ways

Profile and model data is never executed as host-language code.

1. **Lint.** `eslint.config.js` bans `eval`, `new Function`, `Function()`,
   implied eval, and dynamic `import()` of computed paths.
2. **Runtime.** The CLI runs with `--disallow-code-generation-from-strings`,
   and `no-eval.test.ts` runs the whole pipeline under that flag, so a
   dependency that starts using eval fails CI.
3. **Browser.** Serve the app with a CSP that omits `'unsafe-eval'`. The same
   code path passes under the Node flag; confirm in the browser once the
   worker is bundled, since bundling can pull in different code.

Watch for this when adding dependencies: **Ajv compiles schemas with
`new Function`** by default (use its standalone/precompiled mode, or an
interpreting validator such as `@cfworker/json-schema`, which the tests use).
Several template engines do the same.

## Wiring to the renderer

```ts
import { loadWorkspace } from '@arbor/language';
import { toFlowGraph } from '@arbor/adapter-flow';

const { ir, diagnostics } = await loadWorkspace([{ uri: 'shop.arbor', text }, /* profiles */]);
const { nodes, edges } = toFlowGraph(ir, { layout: savedLayout, edgeLayout: savedBends });
// nodes: DiagramNode[], edges: DiagramEdge[] for webgpu-flow
```

`FlowNode`/`FlowEdge` in `packages/adapter-flow/src/index.ts` mirror
[webgpu-flow](https://github.com/javapak/webgpu-flow)'s `DiagramNode`/`DiagramEdge`
(`src/types/index.ts`), and `SHAPES`/`MarkerType` mirror its `SHAPE_TYPES` and
`MarkerType`; keep them in step when the renderer changes. The renderer has no
nesting, so containment is drawn as composition edges (filled diamond at the
owner; `containment: 'hidden'` drops them) and references as open arrows.
Kinds can use a built-in SDF shape or their own `svg`/`image` (see
[docs/LANGUAGE.md](docs/LANGUAGE.md)).

Layout is a pair of sidecars owned by the renderer (`element ID → { x, y, width?, height? }`
and `edge ID → bend points`), so text never carries coordinates. For local
work, clone webgpu-flow into `webgpu-flow/` at the repo root; it is git- and
lint-ignored.

## Studio

`apps/studio` puts the text and the diagram side by side:

```bash
npm run studio      # builds the packages, then serves http://localhost:5173
```

It needs the webgpu-flow clone in `webgpu-flow/` (imported from source through a
Vite alias) and a WebGPU-capable browser.

- **Text → diagram:** every text change re-parses the workspace and redraws the
  diagram from the IR. Diagnostics show inline and in the problems list.
- **Diagram → text:** adding a node from the palette inserts an empty element of
  that kind (`planAddElement`); deleting a node removes its element
  (`planRemoveElement`). Both live in `@arbor/language`, so the studio never
  handles syntax.
- **Layout:** moves, resizes and bend points go to the layout sidecars, never the
  text. Elements without a position are placed in free grid cells.
- **Not written to text yet:** drawing or deleting edges, and label/colour edits.
  The studio says so and redraws from the text.
- Files and layout autosave to the browser's local storage; "Reset to examples"
  starts over.

The editor is CodeMirror with a highlighting-only grammar. Langium's language
server (`packages/language/out/main-browser.js` in a web worker) can replace the
direct `loadWorkspace` calls once completion and go-to-definition are wanted.

## VS Code extension

`apps/vscode` is the editor for real files: VS Code's own text editor talks to
the Langium language server (`main-node.ts`, run under
`--disallow-code-generation-from-strings`), and a custom editor shows the same
document as a diagram with a property form.

```bash
npm run extension   # builds the packages, then bundles the extension into apps/vscode/dist and media/
```

Then press F5 with the **Arbor extension** launch configuration, which opens
`examples/` in an Extension Development Host. Open an `.arbor` file and use
**Arbor: Open Diagram to the Side** (editor title bar) or **Open With… → Arbor Diagram**.
Like the studio, it needs the webgpu-flow clone and WebGPU (VS Code's webviews have it).

- **One document, two editors.** The diagram is a `CustomTextEditorProvider`, so
  VS Code keeps the `TextDocument`: undo, dirty state and save are shared with
  the text editor, and both can be open side by side.
- **The server does the parsing.** The webview never sees text. It asks the
  extension, which asks the server through custom requests (`arbor/model`,
  `arbor/planAddElement`, `arbor/planRemoveElement`, `arbor/planSetSlot`,
  `arbor/locateElement`; see `packages/language/src/lsp/protocol.ts`) and
  applies the returned edits as `WorkspaceEdit`s. The server's workspace holds
  every profile, and `arbor/documentsChanged` redraws open diagrams when one changes.
- **Properties panel.** Selecting one element shows a form generated from its
  kind (`slotSchema` in `@arbor/ir`: inherited properties, enums, references
  limited to elements of the target kind). Each change is one slot edit in
  the text. Text and number fields apply on blur or Enter; × removes the slot so
  the profile default applies again.
- **Workspace trees.** The Arbor activity bar container has three views fed by
  `arbor/workspace` (every profile and model the server knows, with where each
  item is named): **Core Profiles** (profiles that stand alone, like `software`),
  **Domain Profiles** (profiles layered on others: their kinds extend, contain or
  reference another profile's kinds, or use its enums; see `IRIndex.dependsOn`),
  and **Models** (elements nested by containment, with their written slots).
  Clicking an item shows it in the text; elements also have **Reveal in Diagram**.
  The trees refresh after every rebuild, as the diagrams do.
- **Layout lives in a view file**, `<name>.arbor.view.json` next to the model,
  never in browser storage. Its name is the link to the model, and the extension
  nests it under the model in the explorer (when file nesting is on). Coordinates
  are whole pixels and keys are sorted, so it diffs cleanly; changes made on disk
  (a checkout, a hand edit) redraw the diagram. Delete it to start the layout over.
  `schemas/view.schema.json` validates it.

## Decisions so far

- **Text is the source of truth**, the IR is derived and read-only. Diagram
  edits should become text edits against CST ranges (not yet built).
- **Single generic model grammar.** New domains need no grammar change or rebuild.
- **Constraints are declarative only** (types, multiplicity, enums, reference
  kinds). If computed constraints are ever needed, add a small expression
  language interpreted by our own evaluator, never host eval.

## Next steps

- [x] Qualified-name scoping (`Payments.charge`) and per-profile namespaces, so
      kind names can repeat across profiles (`software.Field`). See
      `packages/language/src/language/arbor-scope.ts`.
- [ ] Explicit containment slot syntax for when a child fits several containments.
- [ ] Formatter (canonical output, so LLM-generated and hand-written text diff cleanly).
- [ ] Diagram → text edits: adding and removing elements done (studio);
      edges → reference slots and nested drops → containment still to do.
- [ ] First real emitter targeting core kinds (JSON Schema from `DataType`/`Field`).
- [x] Profile → JSON Schema for dynamic forms (`slotSchema`, used by `@arbor/property-form`).
- [x] Editor next to the renderer: `apps/studio` (CodeMirror; language server worker later).
- [x] VS Code extension: language server, diagram custom editor, property form, view file (`apps/vscode`).
