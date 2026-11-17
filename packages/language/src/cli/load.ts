/**
 * Build a set of in-memory sources into an IR plus structured diagnostics.
 * Works in Node and the browser (no file system access); the CLI reads files
 * and passes the text in.
 */
import { EmptyFileSystem, URI, type LangiumDocument } from 'langium';
import type { IRDocument } from '@arbor/ir';
import type { Document } from '../language/generated/ast.js';
import { createArborServices } from '../language/arbor-module.js';
import { toIR } from '../ir/ast-to-ir.js';

export interface Source { uri: string; text: string }

/** Diagnostic shape meant for both humans and LLM repair loops. */
export interface StructuredDiagnostic {
    uri: string;
    line: number;      // 1-based
    column: number;    // 1-based
    severity: 'error' | 'warning' | 'info' | 'hint';
    code?: string;
    message: string;
    fix?: string;
}

export interface LoadResult {
    ir: IRDocument;
    diagnostics: StructuredDiagnostic[];
    ok: boolean;
}

const SEVERITY = ['error', 'error', 'warning', 'info', 'hint'] as const;

/** Parses, links and validates `sources` together; one document per source, in order. */
export async function buildDocuments(sources: Source[]): Promise<LangiumDocument<Document>[]> {
    const { shared } = createArborServices(EmptyFileSystem);
    const factory = shared.workspace.LangiumDocumentFactory;
    const docs: LangiumDocument<Document>[] = sources.map(s => {
        const doc = factory.fromString<Document>(s.text, URI.parse(toUri(s.uri)));
        shared.workspace.LangiumDocuments.addDocument(doc);
        return doc;
    });
    await shared.workspace.DocumentBuilder.build(docs, { validation: true });
    return docs;
}

export async function loadWorkspace(sources: Source[]): Promise<LoadResult> {
    const docs = await buildDocuments(sources);

    const diagnostics: StructuredDiagnostic[] = docs.flatMap((doc, i) =>
        (doc.diagnostics ?? []).map(d => ({
            uri: sources[i].uri,
            line: d.range.start.line + 1,
            column: d.range.start.character + 1,
            severity: SEVERITY[d.severity ?? 1],
            ...(d.code !== undefined ? { code: String(d.code) } : {}),
            message: typeof d.message === 'string' ? d.message : d.message.value,
            ...(fixOf(d.data) ? { fix: fixOf(d.data) } : {})
        }))
    );
    return {
        ir: toIR(docs.map(d => d.parseResult.value)),
        diagnostics,
        ok: !diagnostics.some(d => d.severity === 'error')
    };
}

function toUri(p: string): string {
    return /^[a-z]+:\/\//i.test(p) ? p : `file:///${p.replace(/^\/+/, '')}`;
}

function fixOf(data: unknown): string | undefined {
    if (data && typeof data === 'object' && 'fix' in data && typeof data.fix === 'string') return data.fix;
    return undefined;
}
