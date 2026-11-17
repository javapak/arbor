import { inject, type Module } from 'langium';
import {
    createDefaultModule, createDefaultSharedModule,
    type DefaultSharedModuleContext, type LangiumServices, type LangiumSharedServices,
    type PartialLangiumServices
} from 'langium/lsp';
import { MdslGeneratedModule, MdslGeneratedSharedModule } from './generated/module.js';
import { MdslValidator, registerValidationChecks } from './mdsl-validator.js';
import { MdslScopeComputation, MdslScopeProvider } from './mdsl-scope.js';

export type MdslAddedServices = {
    validation: {
        MdslValidator: MdslValidator;
    };
    references: {
        ScopeProvider: MdslScopeProvider;
    };
};

export type MdslServices = LangiumServices & MdslAddedServices;

export const MdslModule: Module<MdslServices, PartialLangiumServices & MdslAddedServices> = {
    validation: {
        MdslValidator: (services) => new MdslValidator(services)
    },
    references: {
        ScopeComputation: (services) => new MdslScopeComputation(services),
        ScopeProvider: (services) => new MdslScopeProvider(services)
    }
};

/**
 * Create the services. Pass `EmptyFileSystem` in the browser / web worker,
 * `NodeFileSystem` from `langium/node` in Node.
 */
export function createMdslServices(context: DefaultSharedModuleContext): {
    shared: LangiumSharedServices;
    Mdsl: MdslServices;
} {
    const shared = inject(createDefaultSharedModule(context), MdslGeneratedSharedModule);
    const Mdsl = inject(createDefaultModule({ shared }), MdslGeneratedModule, MdslModule);
    shared.ServiceRegistry.register(Mdsl);
    registerValidationChecks(Mdsl);
    if (!context.connection) {
        // No language client to request a build; mark config as ready.
        void shared.workspace.ConfigurationProvider.initialized({});
    }
    return { shared, Mdsl };
}
