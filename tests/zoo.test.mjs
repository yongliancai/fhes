// 2.5D 園區模擬（src/core/zoo-sim.js）與角色圖片清單（src/data/art-manifest.js）
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, catalogById } from '../src/data/catalog.js';
import { ART_ASSETS, BACKDROPS, PROPS } from '../src/data/art-manifest.js';
import { movementOf, sizeOf, pickBehavior, initActor, stepActor, startBehavior, projectActor, HORIZON } from '../src/core/zoo-sim.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seeded = (seed = 1) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const it = (id) => catalogById.get(id);

test('movement mode follows the creature: fish swim, crabs walk the sea floor, birds and drones fly', () => {
    assert.equal(movementOf(it('ocean-01')), 'swim');
    assert.equal(movementOf(it('ocean-03')), 'walk');      // 寄居蟹
    assert.equal(movementOf(it('ocean-02')), 'walk');      // 海星
    assert.equal(movementOf(it('sky-01')), 'fly');
    assert.equal(movementOf(it('tech-04')), 'fly');        // 無人機
    assert.equal(movementOf(it('land-01')), 'walk');
    assert.equal(movementOf(it('prehistoric-09')), 'swim'); // 滄龍
    assert.equal(movementOf(it('fantasy-06')), 'fly');     // 雲朵鯨
});

test('size class: legendary and whales are large, starfish and seahorses small', () => {
    assert.equal(sizeOf(it('land-12')), 'L');
    assert.equal(sizeOf(it('ocean-12')), 'L');
    assert.equal(sizeOf(it('ocean-02')), 'S');
    assert.equal(sizeOf(it('land-01')), 'M');
});

test('species habits change behaviour frequency (sloth sleeps far more than the dog)', () => {
    const count = (id) => { const r = seeded(7); let n = 0; for (let i = 0; i < 4000; i++) if (pickBehavior(id, r) === 'sleep') n++; return n; };
    assert.ok(count('land-05') > count('land-02') * 3, `sloth ${count('land-05')} vs dog ${count('land-02')}`);
    const r = seeded(3); const seen = new Set(); for (let i = 0; i < 2000; i++) seen.add(pickBehavior('land-04', r));
    assert.ok(seen.has('look'), 'meerkat keeps lookout');
    assert.ok(!new Set(Array.from({ length: 2000 }, () => pickBehavior('land-02', seeded(5)))).has('look'), 'dog never does lookout');
});

test('every creature stays inside the habitat during a long simulation', () => {
    for (const world of ['land', 'ocean', 'sky', 'tech', 'prehistoric', 'fantasy']) {
        const items = CATALOG.filter(x => x.world === world);
        const r = seeded(world.length * 11);
        const actors = items.map((x, i) => initActor(x, i, items.length, r));
        for (let f = 0; f < 3000; f++) for (const a of actors) stepActor(a, 1 / 30, actors, r);
        for (const a of actors) {
            assert.ok(a.x >= 0 && a.x <= 1 && a.z >= 0 && a.z <= 1, `${a.id} x=${a.x} z=${a.z}`);
            if (a.mode !== 'walk') assert.ok(a.y >= 0.08 && a.y <= 0.74, `${a.id} y=${a.y}`);
            const p = projectActor(a, world);
            assert.ok(p.y > 0 && p.y <= 1.01, `${a.id} on screen (${p.y})`);
            if (a.mode === 'walk') assert.ok(p.y >= HORIZON[world] - 1e-9, `${a.id} stands on the ground`);
        }
    }
});

test('wandering moves toward the target and turns to face the direction of travel', () => {
    const a = initActor(it('land-01'), 0, 1, seeded(9));
    a.x = 0.5; startBehavior(a, 'wander', seeded(1)); a.tx = 0.8; a.tz = a.z;
    stepActor(a, 0.5, [a]);
    assert.ok(a.x > 0.5 && a.face === 1);
    a.tx = 0.2; stepActor(a, 0.5, [a]);
    assert.equal(a.face, -1);
});

test('two nearby creatures can greet each other and face each other', () => {
    const r = seeded(2);
    const a = initActor(it('land-01'), 0, 2, r), b = initActor(it('land-02'), 1, 2, r);
    Object.assign(a, { x: 0.4, z: 0.6, t: 99, dur: 0 }); Object.assign(b, { x: 0.5, z: 0.6, state: 'idle', t: 0, dur: 50 });
    let greeted = false;
    for (let i = 0; i < 200 && !greeted; i++) { a.t = 99; a.dur = 0; stepActor(a, 0.01, [a, b], r); greeted = a.state === 'greet'; }
    assert.ok(greeted, 'greet happens when a partner is close');
    assert.equal(b.state, 'greet');
    assert.equal(a.face, 1); assert.equal(b.face, -1);
});

test('nearer creatures are drawn larger and in front', () => {
    const a = initActor(it('land-01'), 0, 1, seeded(1));
    a.z = 0.1; const far = projectActor(a, 'land');
    a.z = 0.9; const near = projectActor(a, 'land');
    assert.ok(near.h > far.h && near.zIndex > far.zIndex && near.y > far.y);
});

test('art manifest: every backdrop and prop listed has its processed image', () => {
    for (const w of BACKDROPS) {
        assert.ok(['land', 'ocean', 'sky', 'tech', 'prehistoric', 'fantasy'].includes(w));
        assert.ok(existsSync(resolve(root, `assets/creatures/bg-${w}.webp`)), `bg-${w}.webp exists`);
    }
    for (const [id, ratio] of Object.entries(PROPS)) {
        assert.ok(ratio > 0.1 && ratio < 10, `${id} aspect ratio`);
        assert.ok(existsSync(resolve(root, `assets/creatures/${id}.webp`)), `${id}.webp exists`);
    }
});

test('art manifest only lists real catalog items whose processed image exists', () => {
    for (const [id, stages] of Object.entries(ART_ASSETS)) {
        assert.ok(catalogById.has(id), `${id} is a catalog item`);
        for (const st of stages) {
            assert.ok(['adult', 'young'].includes(st));
            assert.ok(existsSync(resolve(root, `assets/creatures/${id}_${st}.webp`)), `assets/creatures/${id}_${st}.webp exists`);
        }
    }
});
