/** Language server entry for Node (VS Code extension, CLI tooling). */
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createMdslServices } from './language/mdsl-module.js';

const connection = createConnection(ProposedFeatures.all);
const { shared } = createMdslServices({ connection, ...NodeFileSystem });
startLanguageServer(shared);
