// mdsl: one grammar, two kinds of file.
//
//   profile <Name> { ... }   M2: defines element kinds   (MOF / EMOF analog)
//   model   <Name> { ... }   M1: instances of those kinds
//
// The grammar itself is the M3 layer and is the only fixed syntax.
// Adding a new domain means writing a profile, never touching this file.
//
// LLM-friendly by construction: keyword-first, braces everywhere,
// no significant whitespace, one shape for every element.

grammar Mdsl

entry Document: Profile | Model;

// ======================================================================
// Profiles (M2)
// ======================================================================

Profile:
    'profile' name=ID ('version' version=STRING)? '{'
        (kinds+=Kind | enums+=EnumDecl)*
    '}';

Kind:
    (abstract?='abstract')? 'kind' name=ID
        ('extends' supers+=[Kind:ID] (',' supers+=[Kind:ID])*)?
    '{'
        (features+=Feature | visuals+=Visual)*
    '}';

Feature: PropFeature | ContainsFeature | RefFeature;

// prop tableName: string = "users"
PropFeature:
    'prop' name=FeatureName ':' type=TypeRef multiplicity=Multiplicity? ('=' default=Literal)?;

// contains fields: Field [0..*]
ContainsFeature:
    'contains' name=FeatureName ':' target=[Kind:ID] multiplicity=Multiplicity?;

// ref returns: DataType [1]
RefFeature:
    'ref' name=FeatureName ':' target=[Kind:ID] multiplicity=Multiplicity?;

TypeRef: PrimitiveTypeRef | EnumTypeRef;
PrimitiveTypeRef: primitive=('string' | 'int' | 'float' | 'bool');
EnumTypeRef: enum=[EnumDecl:ID];

// [1]  [0..1]  [1..*]  [*]
Multiplicity:
    '[' (many?='*' | lower=NUMBER ('..' (upper=NUMBER | many?='*'))?) ']';

// Render hints, passed through the IR to the renderer adapter.
Visual:
    'visual' '{' (entries+=VisualEntry)* '}';
VisualEntry:
    key=FeatureName ':' value=Literal;

EnumDecl:
    'enum' name=ID '{' literals+=EnumLiteral (',' literals+=EnumLiteral)* ','? '}';
EnumLiteral:
    name=ID;

// ======================================================================
// Models (M1): one generic shape for every element of every domain.
//
//   <Kind> <Name> (@"stable-id")? { slot: value  ...  <nested elements> }
// ======================================================================

Model:
    'model' name=ID '{'
        (elements+=Element)*
    '}';

Element:
    kind=[Kind:ID] name=ID ('@' stableId=STRING)? '{'
        (slots+=Slot | children+=Element)*
    '}';

Slot:
    name=FeatureName ':' value=Value;

Value: Literal | RefValue | ListValue;
RefValue: '->' target=[Element:ID];
ListValue: '[' (items+=Value (',' items+=Value)*)? ']';

Literal: StringLit | NumberLit | BoolLit | IdLit;
StringLit: value=STRING;
NumberLit: value=NUMBER;
BoolLit: value=('true' | 'false');
IdLit: value=ID;   // enum literals

// Keywords are still allowed as feature/slot names (e.g. `version: "1.0"`).
FeatureName returns string:
    ID | 'version' | 'kind' | 'model' | 'profile' | 'visual' | 'enum'
       | 'abstract' | 'extends' | 'prop' | 'contains' | 'ref'
       | 'string' | 'int' | 'float' | 'bool';

// ======================================================================
// Terminals
// ======================================================================

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w]*/;
terminal NUMBER returns number: /-?[0-9]+(\.[0-9]+)?/;
terminal STRING: /"(\\.|[^"\\])*"/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
