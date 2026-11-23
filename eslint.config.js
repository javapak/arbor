// The one hard rule of this project: profile and model data is never executed
// as host-language code. These rules catch our own code; a CSP without
// 'unsafe-eval' in the web app catches dependencies.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['**/out/**', '**/node_modules/**', '**/generated/**', 'webgpu-flow/**', 'apps/*/dist/**', 'apps/vscode/media/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
            'no-restricted-syntax': [
                'error',
                {
                    selector: "CallExpression[callee.name='Function']",
                    message: 'Function() constructs code from strings. Not allowed.'
                },
                {
                    selector: 'ImportExpression[source.type!="Literal"]',
                    message: 'Dynamic import of computed paths is not allowed.'
                },
                {
                    // React calls whatever an effect returns as its cleanup; a call's result (a Promise from
                    // scrollIntoView, say) breaks the page when it unmounts or re-renders.
                    selector: "CallExpression[callee.name=/^use(Layout)?Effect$/] > ArrowFunctionExpression:first-child[body.type!='BlockStatement'][body.type!='ArrowFunctionExpression'][body.type!='Identifier']",
                    message: 'Give an effect a block body ({ … }), or return a cleanup function: React calls what it returns.'
                }
            ]
        }
    }
);
