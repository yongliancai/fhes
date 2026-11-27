// 學生帳號、初始密碼、密碼政策與 Argon2id（ADR-018）。
import argon2 from 'argon2';
import { randomInt, randomBytes, createHash } from 'node:crypto';

// OWASP 建議的 Argon2id 最低參數：m=19 MiB、t=2、p=1
export const ARGON2_OPTIONS = Object.freeze({ type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

// 去掉容易看錯的字元（0/O、1/l/I、2/Z、5/S…）
const LETTERS = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '3456789';
const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';     // 31 個字元；10 碼約 49.5 bits

const pick = (alphabet, n) => Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');

/** 隨機帳號：3 個字母＋4 個數字（例如 kpm4738） */
export const generateUsername = () => pick(LETTERS, 3) + pick(DIGITS, 4);
/** 初始密碼：10 碼，分兩段方便抄寫（例如 hq7kd-m3xpa） */
export const generateInitialPassword = () => `${pick(PW_ALPHABET, 5)}-${pick(PW_ALPHABET, 5)}`;

export const hashPassword = (pw) => argon2.hash(pw, ARGON2_OPTIONS);
export const verifyPassword = async (hash, pw) => { try { return await argon2.verify(hash, pw); } catch { return false; } };

/** 帳號不存在時也做一次驗證，讓回應時間一致（防帳號列舉） */
let dummyHash = null;
export const dummyVerify = async (pw) => {
    dummyHash ??= await hashPassword(randomBytes(16).toString('hex'));
    await verifyPassword(dummyHash, String(pw || ''));
    return false;
};

const COMMON = new Set(['password', 'password1', '12345678', '123456789', '1234567890', '11111111', '00000000', 'qwertyui', 'qwerty123', 'abcdefgh',
    'abcd1234', 'iloveyou', 'aaaaaaaa', '87654321', 'asdfghjk', 'zxcvbnm1', 'abc12345', 'pass1234', 'welcome1', 'student1', 'student123', 'football', 'princess']);

const isSequence = (s) => {
    if (s.length < 4) return false;
    const c = [...s].map(ch => ch.charCodeAt(0));
    const step = c[1] - c[0];
    return Math.abs(step) === 1 && c.every((x, i) => i === 0 || x - c[i - 1] === step);
};

/** 新密碼政策；回傳錯誤訊息（給國小學生看得懂）或 null */
export const passwordProblem = (pw, { username = '', initial = '' } = {}) => {
    if (typeof pw !== 'string') return '請輸入密碼';
    if (pw.length < 8) return '密碼至少要 8 個字';
    if (pw.length > 64) return '密碼最多 64 個字';
    const lower = pw.toLowerCase();
    if (username && lower.includes(username.toLowerCase())) return '密碼不能包含帳號';
    if (initial && pw === initial) return '請換一個和老師給的不一樣的密碼';
    if (new Set(pw).size <= 2) return '密碼不能只用一兩種字元';
    if (isSequence(lower)) return '密碼不能是連續的數字或字母';
    if (COMMON.has(lower)) return '這個密碼太常見了，請換一個';
    return null;
};

/**
 * 邀請碼與個別綁定碼：10 碼、31 個不易混淆的字元（約 2^49 種），顯示成 5-5 兩段。
 * normalizeCode：大小寫、空白、連字號都可以；格式不對回 null（不查資料庫）。
 */
export const generateCode = () => `${pick(PW_ALPHABET, 5)}-${pick(PW_ALPHABET, 5)}`;
export const normalizeCode = (s) => {
    const c = String(s ?? '').toLowerCase().replace(/[\s-]/g, '');
    return c.length === 10 && [...c].every(ch => PW_ALPHABET.includes(ch)) ? c : null;
};

/** 不透明 token（256 bits）與它的 SHA-256 */
export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
