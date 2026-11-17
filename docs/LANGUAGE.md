# mdsl language reference

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
}
```

- Property types: `string`, `int`, `float`, `bool`, or an enum name.
- Multiplicity: `[1]`, `[0..1]`, `[1..*]`, `[*]`. Defaults: `prop`/`ref` are `[0..1]`, `contains` is `[0..*]`.
- A property with a default is never required.
- `extends` takes one or more kinds; features and visuals inherit, and the nearest definition wins.
- Visual keys: `shape` (`rectangle|circle|diamond|hexagon|package`), `color` (hex), `icon`, `label` (`{name}`, `{kind}`), `width`, `height`, `container`.

## Models

Every element has the same shape:

```
<Kind> <Name> (@"stable-id")? {
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
| reference | `-> Name` |
| list | `[ "a", "b" ]`, `[ -> A, -> B ]` |

- Nested elements go into whichever `contains` feature of the parent accepts their kind; it is an error if none or several do.
- References resolve by simple name to elements at the top level or in an enclosing scope, across files.
- IDs: `@"id"` if given, else `<parentId>.<name>`, rooted at the model name. Give stable IDs to anything a diagram or another system refers to, so renames don't break them.
- Keywords may be used as slot names (`version: "2"`), but not as element names or enum literals.

## Diagnostics

`mdsl check` prints one JSON object per line:

```json
{"uri":"bad.mdsl","line":3,"column":5,"severity":"error","code":"MDSL102",
 "message":"Entity has no feature 'tabelName'. Did you mean 'tableName'?","fix":"tableName"}
```

| Code | Meaning |
|---|---|
| MDSL001 | duplicate name |
| MDSL002 | inheritance cycle |
| MDSL003 | feature redefined as a different feature type |
| MDSL004 | default doesn't match the property type |
| MDSL005 | bad multiplicity |
| MDSL006 | unknown visual key (warning) |
| MDSL101 | abstract kind instantiated |
| MDSL102 | unknown slot (`fix` = closest feature) |
| MDSL103 | value has the wrong type |
| MDSL104 | reference points to the wrong kind |
| MDSL105 | missing required feature (`fix` = feature name) |
| MDSL106 | nested element fits no containment, or several |
| MDSL107 | too many values / children |
| MDSL108 | slot set twice |
| MDSL110 | duplicate element ID |
