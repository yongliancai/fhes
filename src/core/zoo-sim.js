// 2.5D 園區的角色模擬（純函式，不碰 DOM）：移動方式、體型、行為選擇與每格更新。
// 座標：x 0–1（左→右）；z 0–1（遠→近，決定縮放與前後順序）；y 0–1（畫面高度，只給飛行／游泳用）。

const SWIM = new Set(['fish', 'jelly', 'whale', 'ray', 'octopus', 'seahorse', 'turtle']);
const FLY = new Set(['bird', 'serpent']);

/** 移動方式：walk（走在地面）、swim（水中）、fly（空中）。海底爬行的螃蟹、海星走地面。 */
export const movementOf = (item) => {
    const a = item.art || {};
    if (a.props || a.cloud || a.membrane) return 'fly';
    if (FLY.has(a.p)) return 'fly';
    if (SWIM.has(a.p)) return item.world === 'ocean' || item.world === 'prehistoric' || item.world === 'fantasy' ? 'swim' : 'fly';
    return 'walk';
};

/** 體型：S／M／L（決定畫面大小與步伐） */
export const sizeOf = (item) => {
    const a = item.art || {};
    if (item.rarity === 'legendary' || a.big || a.longneck || a.neck || a.mech || a.p === 'whale' || a.wide) return 'L';
    if (a.tiny || a.small || ['star', 'crab', 'trilobite', 'ammonite', 'seahorse'].includes(a.p)) return 'S';
    return 'M';
};
export const SIZE_H = Object.freeze({ S: 0.16, M: 0.22, L: 0.3 });   // 最近處（z=1）佔畫面高度的比例
export const SPEED = Object.freeze({ S: 0.035, M: 0.045, L: 0.03 });   // 每秒移動的畫面寬度比例

/** 各世界的地平線（地面從這個高度開始往下） */
export const HORIZON = Object.freeze({ land: 0.66, ocean: 0.84, sky: 0.86, tech: 0.74, prehistoric: 0.68, fantasy: 0.72 });
export const groundY = (world, z) => { const top = HORIZON[world] ?? 0.7; return top + (0.97 - top) * z; };
export const depthScale = (z) => 0.55 + 0.45 * z;

// 行為權重：預設與物種習性
const BASE = Object.freeze({ idle: 3, wander: 5, sleep: 1, eat: 1.2, play: 1, look: 0 });
const HABITS = Object.freeze({
    'land-01': { sleep: 2.5, play: 1.6 },        // 貓咪愛睡也愛玩
    'land-03': { idle: 6, wander: 2 },           // 水豚很悠哉
    'land-04': { look: 4 },                      // 狐獴站崗
    'land-05': { sleep: 6, wander: 1 },          // 樹懶
    'land-08': { play: 2 },
    'ocean-05': { idle: 5 },
    'ocean-08': { play: 2 },
    'sky-06': { wander: 8 },                     // 蜂鳥停不下來
    'sky-08': { sleep: 5 },                      // 貓頭鷹白天睡覺
    'tech-01': { look: 3, wander: 7 },           // 巡邏
    'tech-02': { wander: 8, sleep: 0 },          // 掃地機器人一直跑
    'prehistoric-01': { idle: 6, wander: 2 },
    'prehistoric-02': { idle: 6, wander: 2 },
    'fantasy-06': { wander: 2, idle: 6 },        // 雲朵鯨慢慢飄
});
export const habitOf = (id) => ({ ...BASE, ...(HABITS[id] || {}) });

/** 依權重抽一個行為；rnd 回傳 [0,1) */
export const pickBehavior = (id, rnd = Math.random, { canGreet = false } = {}) => {
    const w = habitOf(id);
    if (canGreet) w.greet = 2.2;
    const total = Object.values(w).reduce((s, v) => s + v, 0);
    let r = rnd() * total;
    for (const [k, v] of Object.entries(w)) { if ((r -= v) < 0) return k; }
    return 'idle';
};

const DUR = { idle: [1.5, 4], sleep: [5, 9], eat: [2.2, 3.2], play: [1.6, 2.4], look: [2.5, 4.5], greet: [2, 3], pet: [1.2, 1.2], feed: [2.4, 2.4] };
const span = ([a, b], rnd) => a + (b - a) * rnd();

/** 初始狀態：依序散開，避免重疊 */
export const initActor = (item, idx, n, rnd = Math.random) => {
    const mode = movementOf(item);
    const x = 0.1 + 0.8 * ((idx + 0.5) / Math.max(1, n)) + (rnd() - 0.5) * 0.05;
    const z = 0.25 + 0.7 * rnd();
    return { id: item.id, mode, size: sizeOf(item), x, z, y: mode === 'walk' ? null : 0.18 + 0.5 * rnd(), face: rnd() < 0.5 ? -1 : 1,
        state: 'idle', t: rnd() * 2, dur: 1 + rnd() * 2, tx: x, tz: z, ty: null, partner: null };
};

/** 設定新目標（漫遊） */
const newTarget = (a, rnd) => {
    a.tx = Math.min(0.94, Math.max(0.06, a.x + (rnd() - 0.5) * 0.5));
    a.tz = Math.min(1, Math.max(0.05, a.z + (rnd() - 0.5) * 0.6));
    a.ty = a.mode === 'walk' ? null : Math.min(0.72, Math.max(0.1, (a.y ?? 0.4) + (rnd() - 0.5) * 0.3));
};

/** 開始一個行為（外部互動也用這個：pet、feed） */
export const startBehavior = (a, state, rnd = Math.random, partner = null) => {
    a.state = state; a.t = 0; a.partner = partner;
    if (state === 'wander') { newTarget(a, rnd); a.dur = 12; }
    else a.dur = span(DUR[state] || DUR.idle, rnd);
    if (partner) a.face = partner.x < a.x ? -1 : 1;
    return a;
};

/** 每格更新。dt 秒。actors 全體（用來找打招呼對象）。回傳是否有位置變化。 */
export const stepActor = (a, dt, actors, rnd = Math.random) => {
    a.t += dt;
    if (a.state === 'wander') {
        const sp = SPEED[a.size] * (a.mode === 'walk' ? 1 : 0.8);
        const dx = a.tx - a.x, dz = a.tz - a.z, dy = a.ty == null ? 0 : a.ty - a.y;
        const dist = Math.hypot(dx, dz * 0.5, dy * 0.6);
        if (dist < 0.004 || a.t > a.dur) { a.state = 'idle'; a.t = 0; a.dur = span(DUR.idle, rnd); return false; }
        const k = Math.min(1, (sp * dt) / dist);
        a.x += dx * k; a.z += dz * k; if (a.ty != null) a.y += dy * k;
        if (Math.abs(dx) > 0.002) a.face = dx < 0 ? -1 : 1;
        return true;
    }
    if (a.t < a.dur) return false;
    const near = actors.find(o => o !== a && o.state !== 'sleep' && o.state !== 'greet' && o.mode === a.mode && Math.abs(o.x - a.x) < 0.16 && Math.abs(o.z - a.z) < 0.3);
    const next = pickBehavior(a.id, rnd, { canGreet: !!near });
    if (next === 'greet' && near) { startBehavior(a, 'greet', rnd, near); startBehavior(near, 'greet', rnd, a); }
    else startBehavior(a, next === 'greet' ? 'idle' : next, rnd);
    return false;
};

/** 角色在畫面上的位置（腳底中心，0–1）與縮放 */
export const projectActor = (a, world) => {
    const s = depthScale(a.z);
    const y = a.mode === 'walk' ? groundY(world, a.z) : a.y + SIZE_H[a.size] * s;   // 飛行／游泳：y 是身體上緣，換算成腳底
    return { x: a.x, y, scale: s, h: SIZE_H[a.size] * s, zIndex: Math.round(a.z * 1000) };
};
