// 最小 QR Code 編碼器（只做本專案需要的部分：位元組模式、錯誤更正等級 M、版本 1～10，最多 213 個位元組）。
// 依 ISO/IEC 18004 的演算法撰寫，結構參考 Project Nayuki 的 QR Code generator（MIT License）。
// 授權記在 docs/ASSET-LICENSES.md。純函式：不碰 DOM；畫成 SVG 由呼叫端處理。

const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];      // 等級 M，版本 1～10
const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;

const rawModules = (ver) => {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
    return r;
};
const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

// GF(256)，多項式 x^8+x^4+x^3+x^2+1
const gfMul = (x, y) => {
    let z = 0;
    for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
    return z & 0xff;
};
const rsDivisor = (degree) => {
    const r = new Array(degree).fill(0); r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
        root = gfMul(root, 0x02);
    }
    return r;
};
const rsRemainder = (data, divisor) => {
    const r = divisor.map(() => 0);
    for (const b of data) {
        const factor = b ^ r.shift(); r.push(0);
        divisor.forEach((coef, i) => { r[i] ^= gfMul(coef, factor); });
    }
    return r;
};

const alignmentPositions = (ver) => {
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const out = [6];
    for (let pos = ver * 4 + 17 - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
    return out;
};

/**
 * @param {string} text
 * @returns {{ size: number, version: number, modules: boolean[][] }} modules[y][x]，true＝深色
 */
export const encodeQr = (text) => {
    const bytes = [...new TextEncoder().encode(String(text))];
    let ver = 1;
    for (; ver <= MAX_VERSION; ver++) if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver) * 8) break;
    if (ver > MAX_VERSION) throw new RangeError('QR 內容太長');
    const capBits = dataCodewords(ver) * 8;

    // 資料位元：模式 0100、長度、內容、結尾 0、補到整個位元組、補 0xEC/0x11
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
    put(0, Math.min(4, capBits - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

    // 分塊、加上 Reed-Solomon 錯誤更正碼、交錯排列
    const nb = NUM_BLOCKS[ver]; const eccLen = ECC_PER_BLOCK[ver];
    const raw = Math.floor(rawModules(ver) / 8);
    const nShort = nb - raw % nb; const shortLen = Math.floor(raw / nb);
    const div = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
        const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1)); k += dat.length;
        const ecc = rsRemainder(dat, div);
        if (i < nShort) dat.push(0);
        blocks.push(dat.concat(ecc));
    }
    const codewords = [];
    for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) codewords.push(b[i]); });

    const size = ver * 4 + 17;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setF = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };

    // 功能圖形：時序線、定位圖形、校正圖形、格式與版本資訊
    for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const d = Math.max(Math.abs(dx), Math.abs(dy)); const x = cx + dx; const y = cy + dy;
            if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, d !== 2 && d !== 4);
        }
    }
    const al = alignmentPositions(ver); const last = al.length - 1;
    al.forEach((ay, i) => al.forEach((ax, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const drawFormat = (mask) => {
        const d = (0 << 3) | mask;                         // 等級 M 的格式碼＝00
        let rem = d;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const b = ((d << 10) | rem) ^ 0x5412;
        const bit = (i) => ((b >>> i) & 1) !== 0;
        for (let i = 0; i <= 5; i++) setF(8, i, bit(i));
        setF(8, 7, bit(6)); setF(8, 8, bit(7)); setF(7, 8, bit(8));
        for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(i));
        setF(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
        let rem = ver;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const b = (ver << 12) | rem;
        for (let i = 0; i < 18; i++) { const dark = ((b >>> i) & 1) !== 0; const a = size - 11 + i % 3; const c = Math.floor(i / 3); setF(a, c, dark); setF(c, a, dark); }
    }

    // 資料：由右下角開始，兩欄一組上下來回
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
            const x = right - j; const up = ((right + 1) & 2) === 0; const y = up ? size - 1 - v : v;
            if (!fn[y][x] && i < codewords.length * 8) { mod[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
        }
    }

    const MASKS = [
        (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
        (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
        (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
    ];
    const applyMask = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x]; };
    // 罰分（規則 1、2、3、4）：挑最容易被掃描的遮罩
    const penalty = () => {
        let p = 0;
        const line = (get) => {
            for (let a = 0; a < size; a++) {
                let run = 1;
                for (let b = 1; b <= size; b++) {
                    if (b < size && get(a, b) === get(a, b - 1)) run++;
                    else { if (run >= 5) p += run - 2; run = 1; }
                }
                const s = Array.from({ length: size }, (_, b) => get(a, b) ? 1 : 0).join('');
                for (const pat of ['10111010000', '00001011101']) for (let k = s.indexOf(pat); k !== -1; k = s.indexOf(pat, k + 1)) p += 40;
            }
        };
        line((y, x) => mod[y][x]); line((x, y) => mod[y][x]);
        for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3; }
        const dark = mod.flat().filter(Boolean).length; const total = size * size;
        p += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
        return p;
    };
    let best = 0; let bestP = Infinity;
    for (let m = 0; m < 8; m++) { applyMask(m); drawFormat(m); const p = penalty(); if (p < bestP) { bestP = p; best = m; } applyMask(m); }
    applyMask(best); drawFormat(best);
    return { size, version: ver, modules: mod };
};

/** 畫成 SVG 的 path 字串（4 格白邊）。呼叫端用 createElementNS 建立元素，不經過 innerHTML */
export const qrPath = ({ size, modules }, quiet = 4) => {
    const parts = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) parts.push(`M${x + quiet},${y + quiet}h1v1h-1z`);
    return { d: parts.join(''), viewBox: `0 0 ${size + quiet * 2} ${size + quiet * 2}` };
};
