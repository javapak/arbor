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
| `@arbor/language` | Langium, the two above | grammar, validator, AST → IR, CLI, LSP entry points (Node + web worker) |

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
- [ ] Profile → JSON Schema for dynamic forms.
- [x] Editor next to the renderer: `apps/studio` (CodeMirror; language server worker later).
