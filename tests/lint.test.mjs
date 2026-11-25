// ESLint 設定確實生效：未定義變數、未使用變數會被攔下；正常程式通過
import test from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root });
const lint = async (code, file = 'src/core/sample.js') => (await eslint.lintText(code, { filePath: resolve(root, file) }))[0].messages.map(m => m.ruleId);

test('negative: undefined identifier in a module is an error', async () => {
    assert.ok((await lint('export const f = () => notDefinedAnywhere + 1;\n')).includes('no-undef'));
});
test('negative: unused variable is an error', async () => {
    assert.ok((await lint('const unused = 1;\nexport const g = 2;\n')).includes('no-unused-vars'));
});
test('positive: clean module passes', async () => {
    assert.deepEqual(await lint('export const add = (a, b) => a + b;\n'), []);
});
