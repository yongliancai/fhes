// ESLint：只啟用能客觀判定、低誤判的規則（未定義變數、未使用變數、重複鍵、無法到達的程式碼…）
import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['node_modules/**', 'test-results/**', 'coverage/**'] },
    js.configs.recommended,
    {
        files: ['src/**/*.js', '**/*.inline.mjs'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser, google: 'readonly' } },
    },
    {
        files: ['scripts/**/*.mjs', 'server/**/*.mjs', 'tests/**/*.mjs', 'e2e/**/*.mjs', 'eslint.config.js'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    },
    {
        // e2e：page.evaluate / waitForFunction 內的程式在瀏覽器執行
        files: ['e2e/**/*.mjs'],
        languageOptions: { globals: { ...globals.browser } },
    },
    {
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true }],
        },
    },
];
