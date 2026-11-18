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

Profile:
    'profile' name=ID ('version' version=STRING)? '{'
        (kinds+=Kind | enums+=EnumDecl | datatypes+=DataTypeDecl | stereotypes+=StereotypeDecl)*
    '}';

Kind:
    (abstract?='abstract')? 'kind' name=ID
        ('extends' supers+=[Kind:QualifiedName] (',' supers+=[Kind:QualifiedName])*)?
    '{'
        (features+=Feature | visuals+=Visual)*
    '}';

Feature: PropFeature | ContainsFeature | RefFeature;

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
    OppositeClause | SubsetsClause | RedefinesClause;
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
PrimitiveTypeRef: primitive=('string' | 'int' | 'float' | 'bool');
// An enum or a datatype, by name.
NamedTypeRef: decl=[TypeDecl:QualifiedName];
TypeDecl: EnumDecl | DataTypeDecl;

// [1]  [0..1]  [1..*]  [*]
Multiplicity:
    '[' (many?='*' | lower=NUMBER ('..' (upper=NUMBER | many?='*'))?) ']';

// Render hints, passed through the IR to the renderer adapter.
Visual:
    'visual' '{' (entries+=VisualEntry)* '}';
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
//   (<<Stereotype, ...>>)? <Kind> <Name>? (@"stable-id")? { slot: value  ...  <nested elements> }
// ======================================================================

Model:
    'model' name=ID '{'
        (elements+=Element)*
    '}';

// The name may be left out (a UML generalization, say): such an element can't be
// referenced by name, and its ID is `<parent>.<Kind>#<n>` unless it has a stable one.
Element:
    (('<<' | '«') stereotypes+=[StereotypeDecl:QualifiedName] (',' stereotypes+=[StereotypeDecl:QualifiedName])* ('>>' | '»'))?
    kind=[Kind:QualifiedName] name=ID? ('@' stableId=STRING)? '{'
        (slots+=Slot | children+=Element)*
    '}';

Slot:
    name=FeatureName ':' value=Value;

Value: Literal | RefValue | ListValue | RecordValue;
RefValue: '->' target=[Element:QualifiedName];
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

// Keywords are still allowed as feature/slot names (e.g. `version: "1.0"`).
FeatureName returns string:
    ID | 'version' | 'kind' | 'model' | 'profile' | 'visual' | 'enum'
       | 'abstract' | 'extends' | 'prop' | 'contains' | 'ref'
       | 'string' | 'int' | 'float' | 'bool'
       | 'ordered' | 'unique' | 'readonly' | 'derived' | 'opposite' | 'subsets' | 'redefines' | 'datatype' | 'stereotype';

// ======================================================================
// Terminals
// ======================================================================

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w]*/;
terminal NUMBER returns number: /-?[0-9]+(\.[0-9]+)?/;
terminal STRING: /"(\\.|[^"\\])*"/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
