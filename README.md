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
| `@arbor/ir` | nothing | IR types, JSON Schema, `IRIndex` read helpers (inheritance, defaults, visuals) |
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
const { nodes, edges } = toFlowGraph(ir, { layout: savedLayout, containment: 'nest' });
```

`SHAPE_TYPE` and `FlowNode` in `packages/adapter-flow/src/index.ts` are a best
guess at the renderer's `DiagramNode`/`shapeType`; align them with the real types.
Layout is a sidecar (`element ID → { x, y, width?, height? }`) owned by the
renderer, so text never carries coordinates.

For the editor, bundle `packages/language/out/main-browser.js` as a web worker
and connect Monaco to it (see Langium's Monaco tutorial).

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
- [ ] Diagram → text edits (CST-range edits from renderer interactions).
- [ ] First real emitter targeting core kinds (JSON Schema from `DataType`/`Field`).
- [ ] Profile → JSON Schema for dynamic forms.
- [ ] Monaco + web worker demo next to the renderer.
