/** Language server entry for Node (VS Code extension, CLI tooling). */
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createArborServices } from './language/arbor-module.js';
import { registerDiagramRequests } from './lsp/diagram.js';
import { registerOutlineRequests } from './lsp/outline.js';

const connection = createConnection(ProposedFeatures.all);
const { shared } = createArborServices({ connection, ...NodeFileSystem });
registerDiagramRequests(shared, connection);
registerOutlineRequests(shared, connection);
startLanguageServer(shared);
