// v6.2 小組共同照顧的規則（ADR-019）。純函式：後端用來裁決與彙總，學生頁面用來顯示文字。
// 原則：只有正向效果（心情、動畫、裝飾）；不產生 XP、分數、收藏，也不改成長階段；沒有死亡、生病或連續登入壓力。
import { addDays } from './dates.js';

export const CARE_ACTIONS = Object.freeze({ feed: '餵食', pet: '陪伴' });
export const DAILY_CARE_LIMIT = 3;            // 每位學生每天（Asia/Taipei）最多 3 次有效照顧，跨小組合計
export const MOOD_WINDOW_DAYS = 3;            // 心情看最近 3 天（含今天）
export const MOODS = Object.freeze({
    calm: { label: '平靜', icon: '🙂' },
    happy: { label: '開心', icon: '😊' },
    thrilled: { label: '超開心', icon: '🤩' },
});
/** 小組累計有效照顧次數解鎖的園區裝飾（只是外觀） */
export const CARE_BADGES = Object.freeze([
    { at: 10, id: 'flowerbed', name: '花圃', icon: '🌷' },
    { at: 30, id: 'bunting', name: '彩旗', icon: '🎏' },
    { at: 60, id: 'picnic', name: '野餐墊', icon: '🧺' },
    { at: 100, id: 'lights', name: '燈串', icon: '💡' },
    { at: 160, id: 'stage', name: '小舞台', icon: '🎪' },
]);

export const isCareAction = (a) => Object.prototype.hasOwnProperty.call(CARE_ACTIONS, a);

/** 一隻動物最近幾天的照顧次數 → 心情（最低是「平靜」，永遠不會變差到負面） */
export const moodOf = (recentCount) => recentCount >= 6 ? 'thrilled' : recentCount >= 2 ? 'happy' : 'calm';

/** 團隊日門檻：至少一半（無條件進位）的組員照顧過 */
export const teamDayThreshold = (members) => Math.max(1, Math.ceil(Math.max(0, members) / 2));

/** 這一次照顧要不要計入：今天已計入的次數（跨小組）未達上限才計入；回傳要用的 slot（1..3）或 null */
export const nextSlot = (countedToday) => countedToday < DAILY_CARE_LIMIT ? countedToday + 1 : null;

/**
 * 小組照顧彙總。
 * @param {{ events: {itemId, accountId, localDate}[], animalIds: string[], members: number, today: string }} p
 *        events：這個小組「已計入」的照顧紀錄
 */
export const summarizeCare = ({ events, animalIds, members, today }) => {
    const since = addDays(today, -(MOOD_WINDOW_DAYS - 1));
    const animals = Object.fromEntries(animalIds.map(id => {
        const mine = events.filter(e => e.itemId === id);
        const recent = mine.filter(e => e.localDate >= since).length;
        return [id, { care: mine.length, recent, mood: moodOf(recent) }];
    }));
    const total = events.length;
    const byDay = new Map();
    for (const e of events) { if (!byDay.has(e.localDate)) byDay.set(e.localDate, new Set()); byDay.get(e.localDate).add(e.accountId); }
    const need = teamDayThreshold(members);
    const teamStars = [...byDay.values()].filter(s => s.size >= need).length;
    return {
        total,
        animals,
        badges: CARE_BADGES.filter(b => total >= b.at).map(b => b.id),
        nextBadge: CARE_BADGES.find(b => total < b.at) || null,
        teamStars,
        today: { participants: byDay.get(today)?.size || 0, needed: need, members },
    };
};
