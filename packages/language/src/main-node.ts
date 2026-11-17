/** Language server entry for Node (VS Code extension, CLI tooling). */
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createArborServices } from './language/arbor-module.js';

const connection = createConnection(ProposedFeatures.all);
const { shared } = createArborServices({ connection, ...NodeFileSystem });
startLanguageServer(shared);
