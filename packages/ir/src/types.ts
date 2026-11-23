/**
 * The arbor Intermediate Representation (IR).
 *
 * This is the hub. Every importer produces it and every emitter consumes it;
 * nothing converts directly from one format to another.
 *
 * Rules:
 *  - Plain JSON. No classes, no functions, no lazy references.
 *  - Self-describing: the profiles a model uses travel with it.
 *  - References are element IDs, never names.
 *  - No syntax and no layout. Positions live in a sidecar keyed by element ID.
 *  - Derived, not authored. If text is the source of truth, the IR is read-only.
 */

export const IR_VERSION = '0.1.0';

export interface IRDocument {
    irVersion: string;
    profiles: IRProfile[];
    models: IRModel[];
}

// ---------------------------------------------------------------- M2: profiles

export interface IRProfile {
    name: string;
    version?: string;
    kinds: IRKind[];
    enums: IREnum[];
    datatypes: IRDataType[];
    stereotypes: IRStereotype[];
}

export interface IRKind {
    /** Qualified as `<profile>.<kind>`. */
    id: string;
    name: string;
    abstract: boolean;
    /** Kind IDs. */
    extends: string[];
    features: IRFeature[];
    visual: IRVisual;
    /** Visuals for the elements whose property `feature` is `value` (written, or by default), in profile order. */
    visualWhen?: IRConditionalVisual[];
    /** Rules every element of the kind keeps: expressions about the element (see @arbor/expr), true when kept. */
    invariants?: IRInvariant[];
    /** Queries the kind's elements answer, for invariants and derived features. */
    operations?: IRQuery[];
    /** What it plays for the tools (see ROLES): `class`, `machine`… */
    roles?: string[];
}

export interface IRInvariant { name: string; expr: string; message?: string }

/** A primitive type, or an enum, datatype or kind by ID. */
export type IRTypeRef = IRPrimitiveType | { enum: string } | { datatype: string } | { kind: string };

export interface IRQuery {
    name: string;
    params: Array<{ name: string; type: IRTypeRef; multiplicity: IRMultiplicity }>;
    returns: IRTypeRef;
    multiplicity: IRMultiplicity;
    /** A result with several values is an OrderedSet, not a Set. */
    ordered?: true;
    /** An expression giving the result, about the element, with the parameters as variables. */
    body: string;
}

/** `visual when kind = choice { shape: "diamond" }`: restyles elements by a property's value. */
export interface IRConditionalVisual {
    feature: string;
    value: IRScalar;
    visual: IRVisual;
}

export type IRFeature = IRProperty | IRContainment | IRReference;

/**
 * MOF/UML feature modifiers, present only when set. A derived feature's values
 * are computed, never written: a reference with an `opposite` gets the elements
 * pointing at (or containing) the element, and one that others `subsets` gets
 * the union of theirs. Features named in `redefines` are replaced by this one.
 */
export interface IRFeatureModifiers {
    ordered?: true;
    unique?: true;
    readonly?: true;
    derived?: true;
    /** How a derived feature is worked out: an expression about the element (see @arbor/expr). Its values are in the IR. */
    derive?: string;
    /** What it plays for the tools (see ROLES): `attributes`, `guard`… */
    roles?: string[];
    /** The feature of the target kind that points back (references and containments only). */
    opposite?: string;
    /** Features of the same kind whose values include this one's. */
    subsets?: string[];
    /** Inherited features this one replaces. */
    redefines?: string[];
}

export interface IRMultiplicity {
    lower: number;
    /** `null` means unbounded (`*`). */
    upper: number | null;
}

export interface IRProperty extends IRFeatureModifiers {
    feature: 'property';
    name: string;
    type: IRPrimitiveType | { enum: string } | { datatype: string };
    multiplicity: IRMultiplicity;
    default?: IRScalar;
}

export interface IRContainment extends IRFeatureModifiers {
    feature: 'contains';
    name: string;
    /** Kind ID. */
    target: string;
    multiplicity: IRMultiplicity;
    /** How the feature's edges are drawn (EDGE_VISUAL_KEYS), when it sets that. */
    visual?: IRVisual;
}

export interface IRReference extends IRFeatureModifiers {
    feature: 'ref';
    name: string;
    /** Kind ID. */
    target: string;
    multiplicity: IRMultiplicity;
    /** How the feature's edges are drawn (EDGE_VISUAL_KEYS), when it sets that. */
    visual?: IRVisual;
}

/** `expr` and `action` are strings in the expression language: a query, or statements (see @arbor/expr). */
export type IRPrimitiveType = 'string' | 'int' | 'float' | 'bool' | 'expr' | 'action';

/**
 * A UML stereotype: properties and references (tagged values) and visuals that
 * an element of a kind it extends gets when the stereotype is applied to it.
 */
export interface IRStereotype {
    /** Qualified as `<profile>.<stereotype>`. */
    id: string;
    name: string;
    /** Kind IDs it applies to (and to their sub-kinds). */
    extends: string[];
    features: IRFeature[];
    visual: IRVisual;
}

/**
 * A structured value type (a UML DataType): values with fields and no
 * identity, written in place (`{ street: "Main St" }`). Fields are properties.
 */
export interface IRDataType {
    /** Qualified as `<profile>.<datatype>`. */
    id: string;
    name: string;
    features: IRProperty[];
}

export interface IREnum {
    /** Qualified as `<profile>.<enum>`. */
    id: string;
    name: string;
    literals: string[];
}

/** Render hints. Free-form so renderers can grow without IR changes. */
export type IRVisual = Record<string, IRScalar>;

// ---------------------------------------------------------------- M1: models

export interface IRModel {
    name: string;
    /** Every element in the model, flattened. Containment is via `parent`/`children`. */
    elements: IRElement[];
}

export interface IRElement {
    /** Stable ID: explicit `@"id"` if given, else the qualified name. */
    id: string;
    name: string;
    /** Kind ID. */
    kind: string;
    /** Element ID of the container, or null for top-level elements. */
    parent: string | null;
    /** Containment feature name in the parent that holds this element. */
    containedIn: string | null;
    /** Stereotype IDs applied to it, when there are any. Their slots are in `properties` and `references`. */
    stereotypes?: string[];
    children: string[];
    properties: Record<string, IRValue>;
    /** Reference feature name → target element IDs. */
    references: Record<string, string[]>;
}

export type IRScalar = string | number | boolean;
/** A datatype's value: field name -> value (only the fields written). */
export interface IRRecord { [field: string]: IRValue }
export type IRValue = IRScalar | IRRecord | Array<IRScalar | IRRecord>;
