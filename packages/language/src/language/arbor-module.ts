import { inject, type Module } from 'langium';
import {
    createDefaultModule, createDefaultSharedModule,
    type DefaultSharedModuleContext, type LangiumServices, type LangiumSharedServices,
    type PartialLangiumServices
} from 'langium/lsp';
import { ArborGeneratedModule, ArborGeneratedSharedModule } from './generated/module.js';
import { ArborValidator, registerValidationChecks } from './arbor-validator.js';
import { ArborScopeComputation, ArborScopeProvider } from './arbor-scope.js';

export type ArborAddedServices = {
    validation: {
        ArborValidator: ArborValidator;
    };
    references: {
        ScopeProvider: ArborScopeProvider;
    };
};

export type ArborServices = LangiumServices & ArborAddedServices;

export const ArborModule: Module<ArborServices, PartialLangiumServices & ArborAddedServices> = {
    validation: {
        ArborValidator: (services) => new ArborValidator(services)
    },
    references: {
        ScopeComputation: (services) => new ArborScopeComputation(services),
        ScopeProvider: (services) => new ArborScopeProvider(services)
    }
};

/**
 * Create the services. Pass `EmptyFileSystem` in the browser / web worker,
 * `NodeFileSystem` from `langium/node` in Node.
 */
export function createArborServices(context: DefaultSharedModuleContext): {
    shared: LangiumSharedServices;
    Arbor: ArborServices;
} {
    const shared = inject(createDefaultSharedModule(context), ArborGeneratedSharedModule);
    const Arbor = inject(createDefaultModule({ shared }), ArborGeneratedModule, ArborModule);
    shared.ServiceRegistry.register(Arbor);
    registerValidationChecks(Arbor);
    if (!context.connection) {
        // No language client to request a build; mark config as ready.
        void shared.workspace.ConfigurationProvider.initialized({});
    }
    return { shared, Arbor };
}
