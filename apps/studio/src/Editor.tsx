import { useEffect, useRef } from 'react';
import { EditorState, Annotation, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { StreamLanguage } from '@codemirror/language';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';
import type { StructuredDiagnostic } from '@arbor/language';

/** Marks changes that came from outside the editor, so they aren't reported back as typing. */
const external = Annotation.define<boolean>();

const KEYWORDS = new Set([
  'profile', 'model', 'kind', 'abstract', 'extends', 'prop', 'contains', 'ref', 'enum', 'visual', 'version',
  'string', 'int', 'float', 'bool', 'true', 'false',
  'ordered', 'unique', 'readonly', 'derived', 'opposite', 'subsets', 'redefines', 'datatype', 'stereotype',
]);

/** Highlighting only; parsing and checking are the language package's job. */
const arbor = StreamLanguage.define<{ inComment: boolean }>({
  startState: () => ({ inComment: false }),
  token(stream, state) {
    if (state.inComment) {
      if (stream.skipTo('*/')) { stream.match('*/'); state.inComment = false; } else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match('/*')) { state.inComment = true; return 'comment'; }
    if (stream.match(/^"(?:\\.|[^"\\])*"?/)) return 'string';
    if (stream.match(/^-?\d+(\.\d+)?/)) return 'number';
    if (stream.match('->')) return 'operator';
    if (stream.match(/^@/)) return 'meta';
    const word = stream.match(/^[_a-zA-Z]\w*/) as RegExpMatchArray | null;
    if (word) {
      if (KEYWORDS.has(word[0])) return 'keyword';
      return /^[A-Z]/.test(word[0]) ? 'typeName' : 'variableName';
    }
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
});

interface EditorProps {
  uri: string;
  text: string;
  diagnostics: StructuredDiagnostic[];
  onChange: (text: string) => void;
  /** Bumped to move the cursor; `line`/`column` are 1-based. */
  reveal?: { line: number; column: number; n: number };
}

export default function Editor({ uri, text, diagnostics, onChange, reveal }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // One state per file keeps each file's undo history and cursor when switching.
  const states = useRef(new Map<string, EditorState>());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const extensions: Extension[] = [
    basicSetup,
    arbor,
    oneDark,
    lintGutter(),
    EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !update.transactions.some(t => t.annotation(external))) {
        onChangeRef.current(update.state.doc.toString());
      }
    }),
  ];

  useEffect(() => {
    view.current = new EditorView({ parent: host.current! });
    return () => view.current?.destroy();
  }, []);

  // Switch files.
  useEffect(() => {
    const v = view.current!;
    const prevUri = v.dom.dataset.uri;
    if (prevUri === uri) return;
    if (prevUri) states.current.set(prevUri, v.state);
    v.setState(states.current.get(uri) ?? EditorState.create({ doc: text, extensions }));
    v.dom.dataset.uri = uri;
  }, [uri]);

  // Text changed outside the editor (a diagram edit): apply just the changed span.
  useEffect(() => {
    const v = view.current!;
    const doc = v.state.doc.toString();
    if (doc === text) return;
    let start = 0;
    while (start < doc.length && start < text.length && doc[start] === text[start]) start++;
    let endOld = doc.length, endNew = text.length;
    while (endOld > start && endNew > start && doc[endOld - 1] === text[endNew - 1]) { endOld--; endNew--; }
    v.dispatch({ changes: { from: start, to: endOld, insert: text.slice(start, endNew) }, annotations: external.of(true) });
  }, [text, uri]);

  // Diagnostics: from the reported position to the end of the word there.
  useEffect(() => {
    const v = view.current!;
    const doc = v.state.doc;
    const marks: Diagnostic[] = diagnostics.flatMap(d => {
      if (d.line > doc.lines) return [];
      const line = doc.line(d.line);
      const from = Math.min(line.from + d.column - 1, line.to);
      const word = /^[\w."#-]+/.exec(line.text.slice(from - line.from))?.[0] ?? '';
      return [{
        from, to: Math.max(from + word.length, from), message: d.code ? `${d.code}: ${d.message}` : d.message,
        severity: d.severity === 'hint' ? 'info' : d.severity,
      }];
    });
    v.dispatch(setDiagnostics(v.state, marks));
  }, [diagnostics, text, uri]);

  useEffect(() => {
    if (!reveal) return;
    const v = view.current!;
    if (reveal.line > v.state.doc.lines) return;
    const pos = Math.min(v.state.doc.line(reveal.line).from + reveal.column - 1, v.state.doc.length);
    v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    v.focus();
  }, [reveal]);

  return <div ref={host} style={{ height: '100%', overflow: 'hidden' }} />;
}
