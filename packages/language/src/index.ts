export * from './language/mdsl-module.js';
export * from './language/mdsl-validator.js';
export * as semantics from './language/semantics.js';
export * as ast from './language/generated/ast.js';
export { toIR } from './ir/ast-to-ir.js';
export { loadWorkspace, type LoadResult, type StructuredDiagnostic } from './cli/load.js';
