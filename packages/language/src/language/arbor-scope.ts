/**
 * Qualified-name scoping.
 *
 *   Kinds and enums: `Field` or `software.Field`. A profile's own names win
 *   inside that profile; elsewhere a simple name shared by several profiles
 *   is ambiguous (reported by the validator, see `ambiguousTargets`).
 *
 *   Elements: `Payments`, `shop.Payments`, or a path into nested elements,
 *   `Checkout.OrderApi.placeOrder`. The first segment resolves like a simple
 *   name (enclosing scopes, then top-level elements of any model), falling
 *   back to a model name; each further segment names a nested child.
 */
import {
    AstUtils, DefaultScopeComputation, DefaultScopeProvider, EMPTY_STREAM, stream,
    type AstNode, type AstNodeDescription, type AstNodeLocator, type LangiumCoreServices, type LangiumDocument,
    type LangiumDocuments, type ReferenceInfo, type Scope, type Stream
} from 'langium';
import { Element, Model, isDataTypeDecl, isElement, isEnumDecl, isKind, isModel, isProfile, isStereotypeDecl } from './generated/ast.js';

/** Exports kinds/enums as `Name` and `profile.Name`, top-level elements as `Name` and `model.Name`. */
export class ArborScopeComputation extends DefaultScopeComputation {
    protected override addExportedSymbol(node: AstNode, exports: AstNodeDescription[], document: LangiumDocument): void {
        super.addExportedSymbol(node, exports, document);
        const q = qualifiedName(node);
        if (q) exports.push(this.descriptions.createDescription(node, q, document));
    }
}

export class ArborScopeProvider extends DefaultScopeProvider {
    private readonly documents: LangiumDocuments;
    private readonly locator: AstNodeLocator;

    constructor(services: LangiumCoreServices) {
        super(services);
        this.documents = services.shared.workspace.LangiumDocuments;
        this.locator = services.workspace.AstNodeLocator;
    }

    override getScope(context: ReferenceInfo): Scope {
        const scope = super.getScope(context);
        if (this.reflection.getReferenceType(context) !== Element.$type) return scope;
        return new ElementPathScope(scope, name => this.modelsNamed(name), this.descriptions);
    }

    /**
     * Qualified names of every kind, enum or top-level element a simple-name
     * reference could mean, when there is more than one and none is local to
     * the referencing file. Empty when the reference is unambiguous.
     */
    ambiguousTargets(context: ReferenceInfo, target: AstNode | undefined): string[] {
        const name = context.reference.$refText;
        if (!target || name.includes('.')) return [];
        if (AstUtils.getDocument(target) === AstUtils.getDocument(context.container)) return [];
        const type = this.reflection.getReferenceType(context);
        const names = this.indexManager.allElements(type)
            .filter(d => d.name === name)
            .map(d => qualifiedName(this.nodeOf(d)))
            .filter((q): q is string => q !== undefined);
        const distinct = [...new Set(names)];
        return distinct.length > 1 ? distinct : [];
    }

    private modelsNamed(name: string): Model[] {
        return this.indexManager.allElements(Model.$type)
            .filter(d => d.name === name)
            .map(d => this.nodeOf(d))
            .filter(isModel)
            .toArray();
    }

    private nodeOf(d: AstNodeDescription): AstNode | undefined {
        if (d.node) return d.node;
        if (!this.documents.hasDocument(d.documentUri)) return undefined;
        const root = this.documents.getDocument(d.documentUri)!.parseResult.value;
        return this.locator.getAstNode(root, d.path);
    }
}

class ElementPathScope implements Scope {
    constructor(
        private readonly inner: Scope,
        private readonly models: (name: string) => Model[],
        private readonly descriptions: LangiumCoreServices['workspace']['AstNodeDescriptionProvider']
    ) {}

    getElement(name: string): AstNodeDescription | undefined {
        return this.getElements(name).head();
    }

    getElements(name: string): Stream<AstNodeDescription> {
        const direct = this.inner.getElements(name);
        if (!name.includes('.') || !direct.isEmpty()) return direct;
        const [head, ...rest] = name.split('.');
        const fromElement = this.inner.getElement(head)?.node;
        const starts: Element[][] = isElement(fromElement)
            ? [[fromElement]]
            : this.models(head).map(m => m.elements.filter(e => e.name === rest[0]));
        const path = isElement(fromElement) ? rest : rest.slice(1);
        for (const start of starts) {
            for (const el of start) {
                const found = walk(el, path);
                if (found) return stream([this.descriptions.createDescription(found, name)]);
            }
        }
        return EMPTY_STREAM;
    }

    getAllElements(): Stream<AstNodeDescription> {
        return this.inner.getAllElements();
    }
}

function walk(el: Element, path: string[]): Element | undefined {
    let cur: Element | undefined = el;
    for (const seg of path) cur = cur?.children.find(c => c.name === seg);
    return cur;
}

/** `profile.Name` for kinds and enums, `model.Name` for top-level elements. */
export function qualifiedName(node: AstNode | undefined): string | undefined {
    if ((isKind(node) || isEnumDecl(node) || isDataTypeDecl(node) || isStereotypeDecl(node)) && isProfile(node.$container)) return `${node.$container.name}.${node.name}`;
    if (isElement(node) && node.name && isModel(node.$container)) return `${node.$container.name}.${node.name}`;
    return undefined;
}
