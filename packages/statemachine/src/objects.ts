/**
 * Instances of the classes a model describes, for a simulation: what `self`
 * is in a guard or an effect. An instance's attributes start at their default
 * values; calling an operation runs its body, or, if it has none (something
 * outside the model, like sending an email), is just recorded.
 */
import {
    CollectionValue, EvalError, evaluate, execute, parseBlock, parseExpression,
    type Block, type ClassWorld, type Expr, type ExprDiagnostic, type ObjectValue, type Type, type Value, type ValueSpace,
} from '@arbor/expr';

export class Instance {
    constructor(readonly classId: string, readonly slots: Map<string, Value> = new Map()) {}
}

/** An expression that couldn't be parsed or run: which element's slot, and where in its text. */
export interface ExpressionFailure {
    element: string;
    feature: string;
    message: string;
    start: number;
    end: number;
}

/** Calls to operations, as they happen. */
export interface CallRecord { object: Instance; operation: string; args: Value[]; implemented: boolean }

/** Parsed text, kept: the same guard is parsed once however often it's tested. */
export class Parsed {
    private readonly expressions = new Map<string, { value?: Expr; error?: ExprDiagnostic }>();
    private readonly blocks = new Map<string, { value?: Block; error?: ExprDiagnostic }>();
    expression(text: string) {
        let r = this.expressions.get(text);
        if (!r) { const p = parseExpression(text); r = p.value ? { value: p.value } : { error: p.diagnostics[0] }; this.expressions.set(text, r); }
        return r;
    }
    block(text: string) {
        let r = this.blocks.get(text);
        if (!r) { const p = parseBlock(text); r = p.value ? { value: p.value } : { error: p.diagnostics[0] }; this.blocks.set(text, r); }
        return r;
    }
}

export class ObjectStore implements ValueSpace {
    readonly parsed = new Parsed();
    /** Told about each operation call and each failure, in order. */
    onCall: (call: CallRecord) => void = () => {};
    onFailure: (failure: ExpressionFailure) => void = () => {};

    /** The features holding an operation's body and an attribute's default, as the binding names them. */
    private readonly bodyFeature: string | undefined;
    private readonly defaultFeature: string | undefined;

    constructor(readonly world: ClassWorld) {
        this.bodyFeature = world.binding.slots.find(s => s.role === 'body')?.feature;
        this.defaultFeature = world.binding.slots.find(s => s.role === 'default')?.feature;
    }

    /** A new instance, its attributes at their defaults (an empty collection, or null, without one). */
    create(classId: string): Instance {
        const object = new Instance(classId);
        const binding = this.world.binding;
        for (const a of this.world.attributes(classId)) {
            const type = this.world.typeOf(a, binding.attribute.type, binding.attribute.multiplicity);
            object.slots.set(a.name, type.kind === 'collection' ? new CollectionValue(type.collection, []) : null);
        }
        for (const a of this.world.attributes(classId)) {
            const text = this.defaultFeature && this.world.index.get(a, this.defaultFeature);
            if (typeof text !== 'string') continue;
            const value = this.evaluate(text, object, a.id, this.defaultFeature!);
            if (value !== undefined) object.slots.set(a.name, value);
        }
        return object;
    }

    /** An expression's value about `self`, or undefined (and a failure reported) if it has none. */
    evaluate(text: string, self: Instance, element: string, feature: string, variables: Record<string, Value> = {}): Value | undefined {
        const p = this.parsed.expression(text);
        if (!p.value) { this.fail(element, feature, p.error!); return undefined; }
        try {
            return evaluate(p.value, { space: this, self, variables });
        } catch (e) {
            if (e instanceof EvalError) { this.fail(element, feature, e); return undefined; }
            throw e;
        }
    }

    /** Runs statements about `self`; gives what `return` gave. A failure stops them, and is reported. */
    run(text: string, self: Instance, element: string, feature: string, variables: Record<string, Value> = {}): Value | undefined {
        const p = this.parsed.block(text);
        if (!p.value) { this.fail(element, feature, p.error!); return undefined; }
        try {
            return execute(p.value, { space: this, self, variables }).returned;
        } catch (e) {
            if (e instanceof EvalError) { this.fail(element, feature, e); return undefined; }
            throw e;
        }
    }

    private fail(element: string, feature: string, e: { message: string; start: number; end: number }) {
        this.onFailure({ element, feature, message: e.message, start: e.start, end: e.end });
    }

    // ------------------------------------------------------------ ValueSpace

    has(o: ObjectValue, name: string): boolean {
        if (!(o instanceof Instance)) return false;
        return o.slots.has(name) || !!this.world.operationElement(o.classId, name);
    }

    get(o: ObjectValue, name: string): Value {
        if (!(o instanceof Instance)) throw new Error(`'${name}' can't be read: this isn't an instance.`);
        return o.slots.get(name) ?? null;
    }

    set(o: ObjectValue, name: string, value: Value): void {
        if (!(o instanceof Instance)) throw new Error(`'${name}' can't be set: this isn't an instance.`);
        o.slots.set(name, value);
    }

    call(o: ObjectValue, name: string, args: Value[]): Value {
        if (!(o instanceof Instance)) throw new Error(`'${name}' can't be called: this isn't an instance.`);
        const op = this.world.operationElement(o.classId, name);
        const body = op && this.bodyFeature ? this.world.index.get(op, this.bodyFeature) : undefined;
        this.onCall({ object: o, operation: name, args, implemented: typeof body === 'string' });
        if (!op || typeof body !== 'string') return null;
        const info = this.world.operation(o.classId, name);
        const variables = Object.fromEntries((info?.params ?? []).map((p, i) => [p.name, args[i] ?? null]));
        return this.run(body, o, op.id, this.bodyFeature!, variables) ?? null;
    }

    isKindOf(o: ObjectValue, type: string): boolean {
        const t: Type | undefined = this.world.type(type);
        return o instanceof Instance && t?.kind === 'class' && this.world.conforms(o.classId, t.name);
    }

    isTypeOf(o: ObjectValue, type: string): boolean {
        const t = this.world.type(type);
        return o instanceof Instance && t?.kind === 'class' && o.classId === t.name;
    }
}
