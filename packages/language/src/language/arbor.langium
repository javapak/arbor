// arbor: one grammar, two kinds of file.
//
//   profile <Name> { ... }   M2: defines element kinds   (MOF / EMOF analog)
//   model   <Name> { ... }   M1: instances of those kinds
//
// The grammar itself is the M3 layer and is the only fixed syntax.
// Adding a new domain means writing a profile, never touching this file.
//
// LLM-friendly by construction: keyword-first, braces everywhere,
// no significant whitespace, one shape for every element.

grammar Arbor

entry Document: Profile | Model;

// ======================================================================
// Profiles (M2)
// ======================================================================

// A profile may be written in parts, one per file, each named: `profile uml part "StateMachines" { … }`.
// They're one profile: one namespace (`uml.State`), whose names resolve across its parts.
Profile:
    'profile' name=ID ('part' part=STRING)? ('version' version=STRING)? '{'
        (kinds+=Kind | enums+=EnumDecl | datatypes+=DataTypeDecl | stereotypes+=StereotypeDecl)*
    '}';

Kind:
    (abstract?='abstract')? 'kind' name=ID
        ('extends' supers+=[Kind:QualifiedName] (',' supers+=[Kind:QualifiedName])*)?
        ('plays' roles+=FeatureName (',' roles+=FeatureName)*)?
    '{'
        (features+=Feature | visuals+=Visual | invariants+=Invariant | operations+=QueryOperation)*
    '}';

Feature: PropFeature | ContainsFeature | RefFeature;

// A rule every element of the kind keeps, in the expression language (docs/EXPRESSIONS.md), about the element:
// invariant oneInitial: "subvertices->select(…)->size() <= 1" message "A region has at most one initial pseudostate."
Invariant:
    'invariant' name=FeatureName ':' expr=STRING ('message' message=STRING)?;

// A query the kind's elements answer, for invariants and derived features to use:
// query allParents(): Classifier [0..*] = "generalizations.general->…"
QueryOperation:
    (ordered?='ordered')? 'query' name=FeatureName '(' (params+=QueryParameter (',' params+=QueryParameter)*)? ')'
        ':' returns=AnyTypeRef multiplicity=Multiplicity? '=' body=STRING;
QueryParameter:
    name=FeatureName ':' type=AnyTypeRef multiplicity=Multiplicity?;
// A primitive type, or an enum, datatype or kind by name.
AnyTypeRef: PrimitiveTypeRef | AnyNamedTypeRef;
AnyNamedTypeRef: decl=[AnyTypeDecl:QualifiedName];
AnyTypeDecl: EnumDecl | DataTypeDecl | Kind;

// prop tableName: string = "users"
// readonly prop qualifiedName: string [0..1]
PropFeature:
    modifiers+=Modifier* 'prop' name=FeatureName ':' type=TypeRef multiplicity=Multiplicity? ('=' default=Literal)?
        clauses+=FeatureClause*;

// contains fields: Field [0..*]
// ordered contains attributes: Property [0..*] subsets ownedMembers
ContainsFeature:
    modifiers+=Modifier* 'contains' name=FeatureName ':' target=[Kind:QualifiedName] multiplicity=Multiplicity?
        clauses+=FeatureClause* edge=EdgeVisual?;

// ref returns: DataType [1]
// ref general: Classifier [1] { targetMarker: "inheritance" }
// derived ref owningClass: Classifier [0..1] opposite attributes
RefFeature:
    modifiers+=Modifier* 'ref' name=FeatureName ':' target=[Kind:QualifiedName] multiplicity=Multiplicity?
        clauses+=FeatureClause* edge=EdgeVisual?;

// MOF/UML feature modifiers: values kept in order, without duplicates, set
// only when the element is written, or computed (opposites, unions) rather than written.
Modifier returns string:
    'ordered' | 'unique' | 'readonly' | 'derived';

// Relations to other features, named rather than linked (they're checked by the validator):
// the target kind's feature pointing back, the features of this kind whose values
// this feature's include, and the inherited features it replaces.
FeatureClause:
    OppositeClause | SubsetsClause | RedefinesClause | DeriveClause | PlaysClause;
// The parts it plays for the tools (ROLES in @arbor/ir): `contains attributes: Property [0..*] plays attributes`.
PlaysClause:
    'plays' roles+=FeatureName (',' roles+=FeatureName)*;
// How a derived feature is worked out, in the expression language: derived prop qualifiedName: string derive "…"
DeriveClause:
    'derive' expr=STRING;
OppositeClause:
    'opposite' feature=FeatureName;
SubsetsClause:
    'subsets' features+=FeatureName (',' features+=FeatureName)*;
RedefinesClause:
    'redefines' features+=FeatureName (',' features+=FeatureName)*;

// How a feature's edges are drawn: the same entries as a visual block, with edge keys.
EdgeVisual:
    '{' (entries+=VisualEntry)* '}';

TypeRef: PrimitiveTypeRef | NamedTypeRef;
// `expr` and `action` hold text in the expression language (docs/EXPRESSIONS.md): a query, or statements.
PrimitiveTypeRef: primitive=('string' | 'int' | 'float' | 'bool' | 'expr' | 'action');
// An enum or a datatype, by name.
NamedTypeRef: decl=[TypeDecl:QualifiedName];
TypeDecl: EnumDecl | DataTypeDecl;

// [1]  [0..1]  [1..*]  [*]
Multiplicity:
    '[' (many?='*' | lower=NUMBER ('..' (upper=NUMBER | many?='*'))?) ']';

// Render hints, passed through the IR to the renderer adapter.
// `visual when kind = choice { ... }` restyles only the elements whose property has that value
// (written, or its default), like a stereotype's visuals.
Visual:
    'visual' ('when' when=VisualCondition)? '{' (entries+=VisualEntry)* '}';
VisualCondition:
    feature=FeatureName '=' value=Literal;
VisualEntry:
    key=FeatureName ':' value=Literal;

// A UML stereotype: extra properties and references (tagged values), and visuals,
// for elements of the kinds it extends, applied in models as `<<Entity>> Class Customer { ... }`.
StereotypeDecl:
    'stereotype' name=ID 'extends' metaclasses+=[Kind:QualifiedName] (',' metaclasses+=[Kind:QualifiedName])* '{'
        (features+=Feature | visuals+=Visual)*
    '}';

// A structured value type (a UML DataType): values with fields and no identity,
// written in place as `{ street: "Main St"  city: "Oslo" }`.
DataTypeDecl:
    'datatype' name=ID '{' (features+=PropFeature)* '}';

EnumDecl:
    'enum' name=ID '{' literals+=EnumLiteral (',' literals+=EnumLiteral)* ','? '}';
EnumLiteral:
    name=ID;

// ======================================================================
// Models (M1): one generic shape for every element of every domain.
//
//   (<feature> +=)? (<<Stereotype, ...>>)? <Kind> <Name>? (@"stable-id")? { slot: value  ...  <nested elements> }
// ======================================================================

Model:
    'model' name=ID '{'
        (elements+=Element)*
    '}';

// The name may be left out (a UML generalization, say): such an element can't be
// referenced by name, and its ID is `<parent>.<Kind>#<n>` unless it has a stable one.
// A nested element may name the parent's containment that holds it
// (`ownedBehavior += StateMachine sm { ... }`), for when its kind fits several.
Element:
    (feature=FeatureName '+=')?
    (('<<' | '«') stereotypes+=[StereotypeDecl:QualifiedName] (',' stereotypes+=[StereotypeDecl:QualifiedName])* ('>>' | '»'))?
    kind=[Kind:QualifiedName] name=ElementName? ('@' stableId=STRING)? '{'
        (slots+=Slot | children+=Element)*
    '}';

Slot:
    name=FeatureName ':' value=Value;

Value: Literal | RefValue | ListValue | RecordValue;
RefValue: '->' target=[Element:ElementPath];
ListValue: '[' (items+=Value (',' items+=Value)*)? ']';
// A datatype's value: its fields, like an element's slots.
RecordValue: '{' (slots+=Slot)* '}';

Literal: StringLit | NumberLit | BoolLit | IdLit;
StringLit: value=STRING;
NumberLit: value=NUMBER;
BoolLit: value=('true' | 'false');
IdLit: value=ID;   // enum literals

// software.Field, Checkout.OrderApi.placeOrder
QualifiedName returns string:
    ID ('.' ID)*;

// An element's name: an identifier, or any text in quotes (`"Order Line"`, `"operator+"`, `"model"`).
ElementName returns string:
    ID | STRING;
// A path to an element: `Checkout.OrderApi`, `shop."Order Line".total`.
ElementPath returns string:
    ElementName ('.' ElementName)*;

// Keywords are still allowed as feature/slot names (e.g. `version: "1.0"`).
FeatureName returns string:
    ID | 'version' | 'kind' | 'model' | 'profile' | 'visual' | 'enum'
       | 'abstract' | 'extends' | 'prop' | 'contains' | 'ref'
       | 'string' | 'int' | 'float' | 'bool' | 'expr' | 'action'
       | 'ordered' | 'unique' | 'readonly' | 'derived' | 'opposite' | 'subsets' | 'redefines' | 'datatype' | 'stereotype'
       | 'when' | 'invariant' | 'message' | 'query' | 'derive' | 'part' | 'plays';

// ======================================================================
// Terminals
// ======================================================================

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w]*/;
terminal NUMBER returns number: /-?[0-9]+(\.[0-9]+)?/;
terminal STRING: /"(\\.|[^"\\])*"/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
