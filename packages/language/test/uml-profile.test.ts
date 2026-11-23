import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IRIndex } from '@arbor/ir';
import { loadWorkspace } from '../src/cli/load.js';
import { DiagnosticCode as C } from '../src/language/arbor-validator.js';

/** The full UML profile (profiles/uml), all its parts. */
const dir = fileURLToPath(new URL('../../../profiles/uml/', import.meta.url));
const parts = readdirSync(dir).filter(f => f.endsWith('.arbor')).map(f => ({ uri: f, text: readFileSync(dir + f, 'utf8') }));
const example = { uri: 'basics.arbor', text: readFileSync(dir + 'examples/basics.arbor', 'utf8') };

describe('the UML profile', () => {
    it('is clean, in all its parts, and so is its example', async () => {
        const r = await loadWorkspace([...parts, example]);
        expect(r.diagnostics).toEqual([]);
        expect(r.ir.profiles.map(p => p.name)).toEqual(['uml']);
        expect(r.ir.profiles[0].kinds.length).toBeGreaterThan(50);
    });

    it("works out UML's derived features", async () => {
        const r = await loadWorkspace([...parts, example]);
        const index = new IRIndex(r.ir);
        const el = (id: string) => index.elements.get(`basics.Shop.${id}`)!;
        const names = (id: string, ref: string) => (el(id).references[ref] ?? []).map(t => index.elements.get(t)!.properties.qualifiedName);
        expect(el('Catalog.Price.discounts').properties).toMatchObject({ qualifiedName: 'Shop::Catalog::Price::discounts', lower: 0, upper: -1, isComposite: false });
        expect(names('Catalog.Price.discounts', 'namespace')).toEqual(['Shop::Catalog::Price']);
        expect(names('Catalog.Price', 'general')).toEqual(['Shop::Money::Amount']);
        expect(names('Catalog.Price', 'inheritedMember')).toEqual(['Shop::Money::Amount::cents', 'Shop::Money::Amount::currency']);
        expect(names('Catalog.Priced.priceFor', 'type')).toEqual(['Shop::Catalog::Price']);
        expect(names('Catalog', 'importedMember')).toEqual(['Shop::Money::Amount', 'Shop::Money::Currency']);
        expect(names('Catalog', 'member')).toEqual(expect.arrayContaining(['Shop::Money::Amount', 'Shop::Catalog::Price']));
        expect(names('Catalog.positivePrice', 'context')).toEqual(['Shop::Catalog']);
        expect(names('Catalog.pricing', 'relatedElement')).toEqual(['Shop::Catalog::Discounted', 'Shop::Money']);
        expect(names('Catalog.Discounted', 'clientDependency')).toEqual(['Shop::Catalog::pricing']);   // whatever names it as client
    });

    it("reports the elements that break UML's rules, with the rule's message", async () => {
        const r = await loadWorkspace([...parts, { uri: 'bad.arbor', text: `model bad {
            Package P {
                PrimitiveType Integer {}
                DataType A { Generalization { general: -> B } }
                DataType B { Generalization { general: -> A } }
                DataType Done { isFinalSpecialization: true }
                DataType More { Generalization { general: -> Done } }
                Property range { type: -> Integer  lowerValue += LiteralInteger { value: 3 }  upperValue += LiteralUnlimitedNatural { value: "1" } }
                Enumeration Colour { Property hex { type: -> Integer } }
                Interface I {
                    Operation twice { Parameter a { direction: return }  Parameter b { direction: return } }
                    Operation odd { Parameter x { isException: true } }
                    Property hidden { visibility: private }
                }
                Signal Ping {}
                Interface J { Reception pong { signal: -> Ping } }
                ownedRule += Constraint c { specification += OpaqueExpression { body: ["a", "b"]  language: ["OCL"] } }
            }
        }` }]);
        const broken = r.diagnostics.filter(d => d.code === C.BrokenInvariant).map(d => d.message);
        expect(broken).toEqual([
            "DataType A breaks 'no_cycles_in_generalization' (of Classifier): A classifier can't specialize itself, directly or through others.",
            "DataType B breaks 'no_cycles_in_generalization' (of Classifier): A classifier can't specialize itself, directly or through others.",
            "DataType More breaks 'non_final_parents' (of Classifier): A classifier can't specialize one that is final.",
            "Property range breaks 'upper_ge_lower' (of MultiplicityElement): The upper bound is at least the lower bound.",
            "Enumeration Colour breaks 'immutable': An enumeration's attributes are read-only.",
            "Interface I breaks 'visibility': An interface's features are public.",
            "Operation twice breaks 'at_most_one_return': An operation has at most one return parameter.",
            "Parameter x breaks 'not_exception': An exception parameter is out or return.",
            "Reception pong breaks 'same_name_as_signal': A reception has its signal's name.",
            "This OpaqueExpression breaks 'language_body_size': With languages given, each body has one.",   // the specification, unnamed
        ]);
    });
});
