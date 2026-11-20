# arbor language reference

Compact enough to paste into an LLM prompt alongside the profiles in use.

## Two kinds of file, one grammar

| File starts with | Layer | Defines |
|---|---|---|
| `profile <name> { … }` | M2 (MOF/EMOF analog) | element kinds, their features, enums, visuals |
| `model <name> { … }` | M1 | instances of those kinds |

The grammar is the fixed M3 layer. A new domain is a new profile, never a grammar change.

## Profiles

```
profile persistence version "0.1.0" {
    abstract kind Base { prop description: string [0..1] }

    kind Entity extends DataType {
        prop tableName: string [1]            // required
        prop schema:    string = "public"     // default
        contains fields: Column [0..*]        // nested children
        ref      owner:  Team   [0..1]        // reference to another element
        visual { shape: "rectangle" color: "#f59e0b" label: "{name}" icon: "database" }
    }

    enum OnDeleteAction { cascade, setNull, restrict }

    datatype Money {                          // a structured value type
        prop amount:   float [1]
        prop currency: string = "EUR"
    }

    stereotype Audited extends Entity {       // extra slots and visuals, applied per element
        prop retention: int = 30
        visual { color: "#ef4444" }
    }
}
```

- Property types: `string`, `int`, `float`, `bool`, an enum name, or a datatype name.
- A `datatype` is a UML DataType: values with fields and no identity, written in place (`price: { amount: 9.5 }`, see [Models](#models)). Its fields are `prop`s, which may themselves be datatypes; its properties take no default.
- A `stereotype` is a UML stereotype: properties, references and visuals for elements of the kinds it `extends` (and their sub-kinds), added only to elements it's applied to (`<<Audited>> Entity Order { … }`). Its slots are written with the element's own, so their names must be new to those kinds; it adds no containments. Its visuals restyle the element (colour, shape, icon…) but don't change how it's laid out (`container`, `member`, `source`, `target` stay the kind's).
- Multiplicity: `[1]`, `[0..1]`, `[1..*]`, `[*]`. Defaults: `prop`/`ref` are `[0..1]`, `contains` is `[0..*]`.
- A property with a default is never required.
- `extends` takes one or more kinds; features and visuals inherit, and the nearest definition wins.
- Features can carry MOF/UML modifiers before them, and relations to other features after the multiplicity (see [Feature modifiers](#feature-modifiers)).
- Names from another profile can be qualified: `extends software.DataType`, `ref owner: org.Team`. A profile's own names always win inside it, but a bare name from elsewhere breaks as soon as a second profile defines the same name, so **always qualify names from other profiles**.
- Visual keys:
  - `shape`: `rectangle`, `roundedRectangle`, `circle`, `oval`, `diamond`, `hexagon`, `package`, `actor`, `initialNode`, `finalNode`, `none`. Unknown shapes draw as `rectangle`.
  - `svg`: inline SVG markup (use single quotes inside it). `image`: an image URL. Without a `shape` the SVG or image *is* the node; with one, it is drawn on the shape. `tint: true` colors an SVG with the node `color`.
  - `icon`: an emoji drawn on the node.
  - `color`, `labelColor`, `iconColor` (hex), `width`, `height`.
  - `label`: a template with `{name}`, `{kind}`, or any slot: a property's value, or a reference's target names (`"{name} : {type}"`). A reference the label shows isn't also drawn as an edge.
    A slot that isn't set is left empty. An **optional part** `{? … }` is shown only when every slot directly in it is set, so text around a slot disappears with it: `"{name}(){? : {returns}}"` reads `lend() : Date`, or just `chargeFine()`; a UML transition is `"{trigger}{? [{guard}]}{? / {effect}}"`. Optional parts can nest. Any other `{` or `}` is text. An optional part that's never closed is a warning (ARB008). `sourceLabel`, `targetLabel` and edge labels are templates too.
  - `container: true`: the diagram draws the elements this kind contains inside it, as rows (or nested boxes), instead of as composition edges. See [VSCODE.md](VSCODE.md#how-elements-are-drawn).
  - `layout: "free"` (with `container: true`): the contents keep their own shapes and go where they're dragged, like nodes on the canvas, and the container grows to hold them. Use it for diagrams drawn inside a box, such as a state machine's states or a composite state's regions. The default, `"rows"`, lists them in the text's order.
  - `diagram: true`: an element of this kind has a diagram of its own, like a UML state machine or activity. In the diagram around it, it's one node and nothing it contains is drawn; double-click it to open its diagram, where it's the frame around what it contains (with `container: true` and `layout: "free"`, they go where they're dragged). A back button and a breadcrumb return to the diagrams around it. Its contents' positions are stored in the same view file; the frame's isn't, as it goes where they are.
  - `member: true`: elements of this kind are drawn inside whatever contains them, as rows, like a UML class's attributes (`software.Field`, and so `persistence.Column`).
  - `source` and `target`: draw elements of this kind as **edges**, not nodes, between the elements two of its references name, or its `"owner"` (the element containing it). An edge kind can also set `line`, `sourceMarker`, `targetMarker`, `sourceLabel` and `targetLabel` (below), and its `label` is drawn at the middle (default `{name}`). Until both ends are set, the element is drawn as a node, so you can still see it and connect it.

### Visuals by value

A kind can restyle some of its elements by the value of one of their properties: written, or its default.

```
kind Pseudostate extends Vertex {
    prop kind: PseudostateKind = initial
    visual { shape: "initialNode"  color: "#1e293b"  width: 24  height: 24 }
    visual when kind = choice { shape: "diamond"  color: "#e9d5ff"  width: 32  height: 32 }
    visual when kind = fork   { shape: "rectangle"  width: 80  height: 8 }
}
```

- The property is the kind's own or inherited, holds one value, and isn't a datatype; the value fits its type (ARB013 otherwise).
- Blocks that match are applied over the kind's visuals, inherited ones first, then in the order written; an applied stereotype's visuals still come last.
- Like a stereotype's, they restyle (shape, colour, size, label, icon…) but can't change how the kind is laid out: `container`, `layout`, `member`, `source` and `target` are ignored there, with a warning.
- The property they test isn't also listed in the element's box: how it looks already shows it.

### Feature modifiers

The parts of a MOF/UML property that a profile can state, before the feature (modifiers) and after its multiplicity (relations):

```
abstract kind Classifier extends NamedElement {
    derived contains ownedMembers: NamedElement [0..*]                      // a derived union
    ordered contains attributes:   Property [0..*] subsets ownedMembers
    ordered contains operations:   Operation [0..*] subsets ownedMembers
    ref general:                   Classifier [0..*]
    derived ref specifics:         Classifier [0..*] opposite general       // whoever names this one as general
    unique prop keywords:          string [0..*]
    readonly prop qualifiedName:   string [0..1]
}
kind Property extends NamedElement {
    derived ref classifier: Classifier [0..1] opposite attributes            // the classifier it's nested in
    ref type: Classifier [0..1]
}
kind DataProperty extends Property {
    ref dataType: DataType [1] redefines type                                // DataType extends Classifier
}
```

| | Meaning |
|---|---|
| `ordered` | The order values are written in matters (emitters keep it). |
| `unique` | A value may appear only once (ARB111). References and containments never repeat anyway. |
| `readonly` | Set in the text, not changed by editors: forms show it read-only, and the diagram's Connect tool leaves it out. |
| `derived` | Worked out, never written (ARB109). A derived reference with an `opposite` holds the elements that point at it through that reference, or the element containing it through that containment. One that other references `subsets` holds the union of their values. Anything else derived is left for tools to compute. Derived references aren't drawn as edges unless the feature says `{ hidden: false }`, since they repeat what other edges show. A derived containment holds no children directly: a nested element goes into the containments that subset it. |
| `opposite f` | `f` is the target kind's feature pointing back: a reference (which names this one back, if it names any), or a containment (this is then the owner, `[0..1]` or `[1]`). When neither end is derived, both are written, and a model whose ends disagree gets a warning (ARB112). |
| `subsets f, g` | This feature's values are also `f`'s and `g`'s (same kind, same sort of feature, a fitting type, no more values allowed). A nested element fitting a containment and one it subsets goes into the more specific one. |
| `redefines f, g` | Replaces inherited features `f` and `g` (fitting type): elements of this kind no longer have them. Redefining a feature of the same name needs no clause. |

These words (and `when`) are keywords, so they can't be element names or enum literals, but they can still be feature and slot names (`unique: true`).

### Edge styles

A `ref` or `contains` feature can say how its edges are drawn, in braces after it:

```
ref    general:  Classifier [1]   { targetMarker: "triangle" }
ref    uses:     Component  [0..*] { line: "dashed"  targetMarker: "arrow"  label: "«use»" }
ref    owner:    Team       [0..1] { targetLabel: "{name} {multiplicity}" }
contains parts:  Part       [0..*] { sourceMarker: "diamond" }
ref    internal: Thing      [0..1] { hidden: true }
```

| Key | Values |
|---|---|
| `line` | `solid`, `dashed`, `dotted` |
| `sourceMarker`, `targetMarker` | `none`, `arrow` (open, UML navigable), `filledArrow`, `triangle` (hollow, UML generalization), `diamond`, `filledDiamond`, `circle`, `dot`, `bar`, `cross`, `square`, `crowFoot` |
| `color` | hex |
| `label` | text at the middle: a template, `""` for none (default `{name}`) |
| `sourceLabel`, `targetLabel` | text at the ends |
| `hidden` | `true`: no edges for this feature |

In a feature's templates, `{name}` is the feature's name and `{multiplicity}` its multiplicity (`0..*`). In an edge kind's templates, `{…}` are the element's slots, as in `label`. The source of a feature's edge is the element that has the feature. References default to an open arrow at the target, and containment to a filled diamond at the owner.

A UML-style generalization, owned by the specific class and drawn as an edge to the general one:

```
kind Generalization {
    ref general: Classifier [1]
    visual { source: "owner"  target: "general"  targetMarker: "triangle"  label: "" }
}
```

[samples/uml](https://github.com/javapak/arbor/tree/main/samples/uml) has a small UML profile: class diagrams (classes, interfaces, generalizations, realizations, dependencies, associations, compositions) and state machines (regions, states, pseudostates, transitions), an `orm` profile of stereotypes for it, a class model using both, and a loan's lifecycle as a state machine owned by its class (`loan.arbor`). It has its own folder because its kind names (`Package`, `Interface`, `Operation`) would be ambiguous next to `software`'s.

## Models

Every element has the same shape:

```
(<feature> +=)? (<<Stereotype, …>>)? <Kind> <Name>? (@"stable-id")? {
    slot: value
    <nested elements>
}
```

| Value | Syntax |
|---|---|
| string | `"text"` |
| number | `42`, `3.5` |
| bool | `true`, `false` |
| enum literal | `cascade` (bare identifier) |
| reference | `-> Name`, `-> Parent.Child`, `-> model.Name` |
| list | `[ "a", "b" ]`, `[ -> A, -> B ]` |
| datatype value | `{ amount: 9.5  currency: "NOK" }`, its fields like slots (lists of them too) |

- Nested elements go into whichever `contains` feature of the parent accepts their kind; it is an error if none or several do.
- When several fit, name the one that holds it with `feature +=` before the element. A UML `StateMachine` is both a Behavior and a Classifier, so in a class it fits `ownedBehavior` and `nestedClassifier`:

  ```
  Class Door {
      ownedBehavior += StateMachine Lifecycle { … }
      nestedClassifier += Class Hinge { … }
  }
  ```

  The feature must be a non-derived `contains` of the parent that holds the element's kind (ARB106 otherwise, with a `fix` when one containment fits). It counts toward that containment's multiplicity like any other child. Use it only where it's needed: without it, an element still goes into the most specific containment that fits.
- The kind before an element name may be qualified: `software.Field f { … }`. Needed only when several profiles define that kind name.
- References resolve by simple name to elements at the top level or in an enclosing scope, across files. Reach a nested element with a dotted path (`-> Checkout.OrderApi.placeOrder`), and qualify with the model name (`-> shop.Payments`) when several models have a top-level element of that name. A path's first segment is tried as an element first, then as a model name.
- IDs: `@"id"` if given, else `<parentId>.<name>`, rooted at the model name. Give stable IDs to anything a diagram or another system refers to, so renames don't break them.
- The name may be left out, for elements nothing refers to, like a UML generalization: `Generalization { general: -> Item }`. An unnamed element can't be referenced, is labelled `:Kind` in diagrams, and its ID is `<parentId>.<Kind>#<n>`, counting the unnamed elements of that kind among its siblings (without a stable ID) from 1. Reordering them changes the ID, so give one a stable ID if its layout or anything else outside the text matters.
- Stereotypes are applied in `<< >>` (or `« »`) before the kind, several separated by commas. Each must extend the element's kind (ARB113), and their slots are written with the element's own. Diagrams show them before the name: `«Entity» Customer`.
- Keywords may be used as slot names (`version: "2"`), but not as element names or enum literals.

## Diagnostics

`arbor check` prints one JSON object per line:

```json
{"uri":"bad.arbor","line":3,"column":5,"severity":"error","code":"ARB102",
 "message":"Entity has no feature 'tabelName'. Did you mean 'tableName'?","fix":"tableName"}
```

| Code | Meaning |
|---|---|
| ARB001 | duplicate name (in a profile, or two profiles/models with the same name) |
| ARB002 | inheritance cycle |
| ARB003 | feature redefined as a different feature type |
| ARB004 | default doesn't match the property type |
| ARB005 | bad multiplicity |
| ARB006 | unknown visual key (warning) |
| ARB007 | simple name defined by several profiles (or models); write the qualified name listed in the message |
| ARB008 | visual value doesn't fit its key, e.g. unknown shape, non-hex color, or an unclosed `{?` in a template (warning; `fix` = closest shape) |
| ARB009 | bad `opposite`: unknown feature, not a reference or containment, doesn't point back, or names another opposite |
| ARB010 | bad `subsets`: unknown feature, different sort or type, or allows more values than the feature it subsets |
| ARB011 | bad `redefines`: no inherited feature of that name, or a different sort or type |
| ARB012 | bad stereotype: a feature its kinds already have, or a containment |
| ARB013 | bad `visual when`: not a single-valued, non-datatype property of the kind, a value that doesn't fit it, used in a stereotype; or a layout key in it (warning) |
| ARB101 | abstract kind instantiated |
| ARB102 | unknown slot (`fix` = closest feature) |
| ARB103 | value has the wrong type |
| ARB104 | reference points to the wrong kind |
| ARB105 | missing required feature (`fix` = feature name) |
| ARB106 | nested element fits no containment, or several (name one with `feature +=`); or the containment it names can't hold it |
| ARB107 | too many values / children |
| ARB108 | slot set twice |
| ARB109 | a derived feature is written |
| ARB110 | duplicate element ID |
| ARB111 | a value repeated in a `unique` slot |
| ARB112 | written opposite references disagree: a target doesn't point back (warning; `data` names the element and slot) |
| ARB113 | a stereotype applied to a kind it doesn't extend, applied twice, or adding a slot another applied one adds too |
