// 本機示範用學生系統（mock server）：記憶體資料庫 + 合成資料，只在 http://127.0.0.1 執行。
// 用途：在瀏覽器試用 student.html。教師身分用本次執行產生的測試金鑰簽發（只存在記憶體），不連任何 Google 服務。
// 執行：npm run student:dev   → 開 http://127.0.0.1:8790/student.html，用下面印出的合成帳號登入。
import { buildApp } from '../server/src/app.mjs';
import { openDb } from '../server/src/db.mjs';
import { createTestKeys, signJwt, basePayload, TEST_CLIENT_ID, TEACHER_A } from '../tests/helpers/fake-google.mjs';
import { buildClassProjection, projectionHash } from '../src/core/student-projection.js';
import { buildFixture, classData } from '../tests/helpers/v62-fixture.mjs';
import { localDate } from '../src/core/dates.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8790);
const url = `http://127.0.0.1:${PORT}`;
const keys = await createTestKeys();
const app = buildApp({
    db: openDb(':memory:'), jwks: async () => keys.jwks,
    config: { clientId: TEST_CLIENT_ID, teacherAllow: ['@example.test'], teacherOrigins: ['http://127.0.0.1:8765', 'http://localhost:8765'], studentOrigins: [url], ipSalt: 'local-dev-salt-not-secret', staticRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..') },
});
await app.listen({ host: '127.0.0.1', port: PORT });

const nonce = 'local-dev-nonce-1';
const credential = await signJwt(keys.good.privateKey, basePayload({ account: TEACHER_A, nonce }));
const call = async (method, path, payload, token) => (await app.inject({ method, url: path, payload, headers: token ? { authorization: `Bearer ${token}` } : {} })).json();
const { token } = await call('POST', '/api/teacher/session', { credential, nonce });
const fx = buildFixture();
const { classKey } = await call('POST', '/api/teacher/classes', { localClassId: 'cls-a', name: '合成甲班' }, token);
const projection = buildClassProjection(classData(fx, 'cls-a'), { today: localDate() });
const { created } = await call('POST', `/api/teacher/classes/${classKey}/accounts`, { students: projection.students.map(s => ({ localStudentId: s.studentId })) }, token);
await call('PUT', `/api/teacher/classes/${classKey}/projection`, { version: Date.now(), hash: await projectionHash(projection), projection }, token);

console.log(`\n本機學生系統（合成資料）：${url}/student.html\n`);
console.table(created.map(c => ({ 學生: projection.students.find(s => s.studentId === c.localStudentId)?.name, 帳號: c.username, 初始密碼: c.initialPassword })));
console.log('按 Ctrl+C 結束（資料只在記憶體，結束即消失）。');
