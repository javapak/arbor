/**
 * Language server entry for a web worker (Monaco, or your renderer's
 * text pane). No Node APIs, no backend.
 *
 * Bundle with e.g.:
 *   esbuild out/main-browser.js --bundle --format=iife --outfile=public/mdsl-worker.js
 */
import { EmptyFileSystem } from 'langium';
import { startLanguageServer } from 'langium/lsp';
import { BrowserMessageReader, BrowserMessageWriter, createConnection } from 'vscode-languageserver/browser';
import { createMdslServices } from './language/mdsl-module.js';

declare const self: DedicatedWorkerGlobalScope;

const reader = new BrowserMessageReader(self);
const writer = new BrowserMessageWriter(self);
const connection = createConnection(reader, writer);

const { shared } = createMdslServices({ connection, ...EmptyFileSystem });
startLanguageServer(shared);
