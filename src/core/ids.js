// 識別碼與內容雜湊：同步引擎以「內容雜湊」判斷本機/雲端是否變動（三方比對），
// 所以不必在每個寫入點手動標記 dirty。

/** 與 v5 相容的短 ID（時間 + 亂數） */
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** 鍵排序後的 JSON：同內容不同鍵順序 → 相同字串 */
export const stableStringify = (v) => {
    if (v === undefined) return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
};

/** 64-bit FNV-1a（兩個 32-bit 半部），回傳 16 位十六進位字串 */
export const hashString = (s) => {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
        h2 = (h2 ^ (h2 >>> 13)) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
};

export const entityHash = (entity) => hashString(stableStringify(entity));
