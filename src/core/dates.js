// 本地日期工具（Asia/Taipei）。不使用 toISOString，避免 UTC 換日造成日期錯一天。
export const TZ = 'Asia/Taipei';
export const pad2 = (n) => String(n).padStart(2, '0');

const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
export const partsOf = (t) => Object.fromEntries(dateParts.formatToParts(new Date(t)).map(p => [p.type, p.value]));
export const localDate = (t = Date.now()) => { const p = partsOf(t); return `${p.year}-${p.month}-${p.day}`; };
export const localTime = (t) => { const p = partsOf(t); return `${p.hour}:${p.minute}`; };
export const localDateTime = (t) => `${localDate(t)} ${localTime(t)}`;
export const addDays = (ds, n) => {
    const [y, m, d] = ds.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
};
export const mdLabel = (ds) => { const [, m, d] = ds.split('-').map(Number); return `${m} 月 ${d} 日`; };
export const stampForFile = (t = Date.now()) => { const p = partsOf(t); return `${p.year}${p.month}${p.day}_${p.hour}${p.minute}`; };
