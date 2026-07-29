// Flat config, import-free so `npx -y eslint@9 index.js test.mjs` works with no install.
export default [
    {
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                $: 'readonly', jQuery: 'readonly', toastr: 'readonly',
                window: 'readonly', document: 'readonly', console: 'readonly',
                fetch: 'readonly', WebSocket: 'readonly', Image: 'readonly', FileReader: 'readonly',
                Blob: 'readonly', Response: 'readonly', DecompressionStream: 'readonly',
                DataView: 'readonly', Uint8Array: 'readonly', btoa: 'readonly',
                setTimeout: 'readonly', clearTimeout: 'readonly',
                structuredClone: 'readonly', URL: 'readonly', process: 'readonly',
                crypto: 'readonly',
            },
        },
        rules: {
            'no-undef': 'error',
            'no-dupe-keys': 'error',
            'no-dupe-args': 'error',
            'no-redeclare': 'error',
            'no-unreachable': 'error',
            'no-cond-assign': ['error', 'except-parens'],
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
        },
    },
];
