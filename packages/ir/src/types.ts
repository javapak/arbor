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
}

export type IRFeature = IRProperty | IRContainment | IRReference;

export interface IRMultiplicity {
    lower: number;
    /** `null` means unbounded (`*`). */
    upper: number | null;
}

export interface IRProperty {
    feature: 'property';
    name: string;
    type: IRPrimitiveType | { enum: string };
    multiplicity: IRMultiplicity;
    default?: IRScalar;
}

export interface IRContainment {
    feature: 'contains';
    name: string;
    /** Kind ID. */
    target: string;
    multiplicity: IRMultiplicity;
}

export interface IRReference {
    feature: 'ref';
    name: string;
    /** Kind ID. */
    target: string;
    multiplicity: IRMultiplicity;
}

export type IRPrimitiveType = 'string' | 'int' | 'float' | 'bool';

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
    children: string[];
    properties: Record<string, IRValue>;
    /** Reference feature name → target element IDs. */
    references: Record<string, string[]>;
}

export type IRScalar = string | number | boolean;
export type IRValue = IRScalar | IRScalar[];
