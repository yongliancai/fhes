// src/vendor/qr.js：沒有外部解碼器可用，所以用兩種方式驗證：
// 1. 規格書上公開的固定值（生成多項式、格式資訊、版本資訊）
// 2. 測試裡寫一個「反向讀取」：從畫好的矩陣讀回格式資訊（BCH 檢查）、解遮罩、照 Z 字形讀出碼字、拆回各區塊、
//    用 Reed-Solomon 症狀值（和編碼時的除法是不同的計算）確認沒有錯誤，最後解回原本的文字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr, qrPath } from '../src/vendor/qr.js';

// GF(256) 指數／對數表（獨立於編碼器的實作）
const EXP = new Array(512); const LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

const ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; const NB = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0, (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];

/** 依規格標出功能區（定位、分隔、時序、校正、格式、版本、暗模組） */
const functionMap = (ver) => {
    const size = ver * 4 + 17; const f = Array.from({ length: size }, () => new Array(size).fill(false));
    const box = (x0, y0, w, h) => { for (let y = Math.max(0, y0); y < Math.min(size, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(size, x0 + w); x++) f[y][x] = true; };
    box(0, 0, 9, 9); box(size - 8, 0, 8, 9); box(0, size - 8, 9, 8);
    box(6, 0, 1, size); box(0, 6, size, 1);
    if (ver > 1) {
        const n = Math.floor(ver / 7) + 2; const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
        const pos = [6]; for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
        for (const a of pos) for (const b of pos) if (!((a === 6 && b === 6) || (a === 6 && b === size - 7) || (a === size - 7 && b === 6))) box(b - 2, a - 2, 5, 5);
    }
    if (ver >= 7) { box(size - 11, 0, 3, 6); box(0, size - 11, 6, 3); }
    return f;
};

const decode = ({ size, version: ver, modules: m }) => {
    assert.equal(size, ver * 4 + 17);
    // 格式資訊（左上那一份），BCH(15,5) 檢查
    const fb = [];
    for (let i = 0; i <= 5; i++) fb[i] = m[i][8];
    fb[6] = m[7][8]; fb[7] = m[8][8]; fb[8] = m[8][7];
    for (let i = 9; i < 15; i++) fb[i] = m[8][14 - i];
    const fmt = fb.reduce((a, b, i) => a | ((b ? 1 : 0) << i), 0) ^ 0x5412;
    let rem = fmt >>> 10; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    assert.equal(((fmt >>> 10) << 10 | rem), fmt, 'format bits are a valid BCH code word');
    // 另一份格式資訊要一樣
    const fb2 = [];
    for (let i = 0; i < 8; i++) fb2[i] = m[8][size - 1 - i];
    for (let i = 8; i < 15; i++) fb2[i] = m[size - 15 + i][8];
    assert.deepEqual(fb2, fb, 'both copies of the format information agree');
    assert.equal(m[size - 8][8], true, 'dark module');
    assert.equal(fmt >>> 13, 0, 'error correction level M');
    const mask = (fmt >>> 10) & 7;
    // 讀出碼字
    const f = functionMap(ver); const bits = [];
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
            const x = right - j; const y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
            if (!f[y][x]) bits.push(m[y][x] !== MASKS[mask](x, y));
        }
    }
    const raw = Math.floor(bits.length / 8); const cw = [];
    for (let i = 0; i < raw; i++) cw.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | (b ? 1 : 0), 0));
    // 拆回區塊
    const nb = NB[ver]; const ecc = ECC[ver]; const nShort = nb - raw % nb; const shortLen = Math.floor(raw / nb);
    const blocks = Array.from({ length: nb }, (_, j) => new Array(shortLen + (j < nShort ? 0 : 1)));
    let k = 0;
    for (let i = 0; i < shortLen + 1; i++) for (let j = 0; j < nb; j++) {
        const dataLen = shortLen - ecc + (j < nShort ? 0 : 1);
        if (i < dataLen) blocks[j][i] = cw[k++];
    }
    for (let i = 0; i < ecc; i++) for (let j = 0; j < nb; j++) blocks[j][shortLen - ecc + (j < nShort ? 0 : 1) + i] = cw[k++];
    assert.equal(k, raw);
    // 症狀值：S_i = C(α^i)，i = 0..ecc-1，全部要是 0
    const data = [];
    for (const b of blocks) {
        for (let i = 0; i < ecc; i++) { let s = 0; for (const c of b) s = mul(s, EXP[i]) ^ c; assert.equal(s, 0, `syndrome ${i}`); }
        data.push(...b.slice(0, b.length - ecc));
    }
    // 位元組模式解碼
    const db = data.flatMap(b => Array.from({ length: 8 }, (_, i) => (b >>> (7 - i)) & 1));
    let p = 0; const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | db[p++]; return v; };
    assert.equal(take(4), 4, 'byte mode');
    const len = take(ver < 10 ? 8 : 16);
    return new TextDecoder().decode(new Uint8Array(Array.from({ length: len }, () => take(8))));
};

test('QR: round trip for short and long texts across versions 1–10, including the student join link and non-ASCII', () => {
    const samples = ['a', 'HELLO WORLD', 'https://fhes.school.example.edu.tw/student.html#join=abcde-fghjk', '加入班級 ✓', 'x'.repeat(100), 'y'.repeat(150), 'z'.repeat(213)];
    const versions = new Set();
    for (const s of samples) { const q = encodeQr(s); versions.add(q.version); assert.equal(decode(q), s); }
    assert.ok(versions.has(1) && versions.has(10) && [...versions].some(v => v >= 7 && v < 10), `versions covered: ${[...versions]}`);
    assert.throws(() => encodeQr('x'.repeat(214)), RangeError);
});

test('QR: published reference values (generator polynomial, format and version information, sizes)', () => {
    // ISO/IEC 18004 附錄：10 個錯誤更正碼字的生成多項式係數（α 的指數）
    const gen = [1]; for (let i = 0; i < 10; i++) { const next = new Array(gen.length + 1).fill(0); gen.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); }); gen.splice(0, gen.length, ...next); }
    assert.deepEqual(gen.slice(1).map(c => LOG[c]), [251, 67, 46, 61, 118, 70, 64, 94, 32, 45]);
    // 版本 1 一定是 21×21；「a」的格式資訊必須是規格表上等級 M 的其中一組
    const q = encodeQr('a');
    assert.equal(q.size, 21);
    const M_FORMATS = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
    const row = [0, 1, 2, 3, 4, 5, 7, 8].map(x => q.modules[8][x]).concat([7, 5, 4, 3, 2, 1, 0].map(y => q.modules[y][8])).map(b => (b ? '1' : '0')).join('');
    assert.ok(M_FORMATS.includes(row), `format string ${row}`);
    // 版本 7 的版本資訊（規格表：000111110010010100）
    const v7 = encodeQr('v'.repeat(115));
    assert.equal(v7.version, 7);
    const vb = Array.from({ length: 18 }, (_, i) => v7.modules[Math.floor(i / 3)][v7.size - 11 + i % 3] ? 1 : 0).reverse().join('');
    assert.equal(vb, '000111110010010100');
    const { d, viewBox } = qrPath(q);
    assert.equal(viewBox, '0 0 29 29'); assert.match(d, /^(M\d+,\d+h1v1h-1z)+$/);
});
