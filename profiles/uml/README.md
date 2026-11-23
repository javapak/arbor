# UML 2.5.1 as an arbor profile

The UML metamodel written as one arbor profile, `uml`, in parts: one file per clause of the specification. Each kind is a UML metaclass with UML's properties, its derived properties worked out (`derive`), its queries (`query`) and its well-formedness rules (`invariant`) in the [expression language](../../docs/EXPRESSIONS.md) (OCL), and notation for diagrams (`visual`). [examples/basics.arbor](examples/basics.arbor) is a model in it.

Load all the parts together (they're one profile; see [LANGUAGE.md](../../docs/LANGUAGE.md#profiles-in-parts)), with the models that use them:

```bash
npm run check -- profiles/uml/*.arbor profiles/uml/examples/basics.arbor
```

[samples/uml](../../samples/uml) is a separate, much smaller profile for learning arbor; the two don't load together (both are named `uml`).

## What's here

| Clause | Part | Metaclasses |
|---|---|---|
| 7 Common Structure | [common-structure.arbor](common-structure.arbor) | Element, Comment, NamedElement, Namespace, PackageableElement, ElementImport, PackageImport, Type, TypedElement, MultiplicityElement, Constraint, Relationship, DirectedRelationship, Dependency, Abstraction, Realization, Usage; TemplateableElement and ParameterableElement (empty) |
| 8 Values | [values.arbor](values.arbor) | ValueSpecification, LiteralSpecification, LiteralBoolean, LiteralInteger, LiteralReal, LiteralString, LiteralUnlimitedNatural, LiteralNull, Expression, StringExpression, OpaqueExpression, InstanceValue |
| 9 Classification | [classification.arbor](classification.arbor) | RedefinableElement, Classifier, Generalization, GeneralizationSet, Substitution, Feature, StructuralFeature, BehavioralFeature, Parameter, Property, Operation, InstanceSpecification, Slot |
| 10 Simple Classifiers | [simple-classifiers.arbor](simple-classifiers.arbor) | DataType, PrimitiveType, Enumeration, EnumerationLiteral, Signal, Reception, Interface |
| 12 Packages | [packages.arbor](packages.arbor) | Package, PackageMerge, Model, Profile, ProfileApplication |

Derived: ownership (`ownedElement`, `owner`, `namespace` and every owner opposite), `qualifiedName`, `member`, `importedMember`, `inheritedMember`, `general`, `feature`, `attribute`, `featuringClassifier`, `lower`, `upper`, `isComposite`, an operation's `type`, a package's `nestedPackage` and `ownedType`, relationships' `source`, `target`, `relatedElement`, `clientDependency`. Rules: generalization cycles and final parents, multiplicity bounds, imports (of self, of owned members, visibility), visibilities, parameters (returns, exceptions, effects), enumerations, interfaces, receptions, instance slots, constraints, opaque expressions.

## How UML is written here

- **Names** are arbor's: written before the braces (quoted if they need to be, `Operation "+"`), not a `name` property. Siblings can't share one (ARB110), which keeps UML's members_distinguishable more strictly.
- **Ownership** is nesting. Where an element fits several of its owner's containments, name the one (`ownedRule += Constraint …`, `lowerValue += LiteralInteger { value: 0 }`): a constraint is also a packageable element, a value specification can be a default or a bound.
- **UnlimitedNatural** is an `int` in derived values and queries, -1 for *; LiteralUnlimitedNatural's value is written `"*"` or digits.
- **Relationships that redefine their ends**: a Substitution's client and supplier are its owner and its contract (`redefines`), so they aren't written twice.

## Not yet

- The other clauses: 11 Structured Classifiers (Class, Association, ports, connectors), 13 Common Behavior (Behavior, BehavioredClassifier, InterfaceRealization, events), 14 State Machines, 15 Activities, 16 Actions, 17 Interactions, 18 Use Cases, 19 Deployments, 20 Information Flows; and in 12, Stereotype, Extension and Image (a stereotype is a Class).
- Templates (7.3), and time and durations (8.4).
- Properties of the metaclasses here that belong to those clauses: Property's association, class and qualifiers, Classifier's use cases and collaborations, BehavioralFeature's methods, Interface's protocol. They're added to these kinds as their clauses arrive.
- Rules needing a value's own type (OCL's `oclType()`, which the expression language doesn't have): specialize_type, redefinition consistency, subsetting rules. And Parameter extends MultiplicityElement and TypedElement directly, until ConnectableElement (clause 11) is here.
- Roles (`plays`), so models' own expressions are type-checked and their state machines simulated as with samples/uml: they come with Common Behavior, where operation bodies and defaults are behaviors and value specifications, not plain expressions.
- Notation: an operation's label lists all its parameters, the return one too.
