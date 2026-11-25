// 產生 AI 生圖提示詞包（收藏公仔風）。來源：src/data/catalog.js ＋ 本檔的角色描述。
// 用法：node scripts/art-prompts.mjs   → 寫出 art/prompts/prompts.json 與 art/prompts/PROMPTS.md
// 美術規範：docs/ART-DIRECTION.md。改描述或規範後重跑本腳本即可，不要手改輸出檔。
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, WORLDS, RARITIES } from '../src/data/catalog.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- 共用風格（母提示詞）
const STYLE = [
    'A 3D rendered collectible vinyl toy figure of {SUBJECT}.',
    '{PROPORTIONS}',
    'Clean simple shapes with a clear, instantly readable silhouette and anatomically correct limb count for the species.',
    'Smooth matte soft-touch vinyl material, large expressive eyes with a single white highlight, confident friendly expression that feels cool rather than babyish (target audience: 11-12 year old students).',
    'Three-quarter view, the character faces to the LEFT side of the image, full body fully visible, character fills about 80% of the frame, centered.',
    'Soft studio lighting from the top-left with a gentle rim light and subtle ambient occlusion.',
    '{WORLD}',
    '{RARITY}',
    '{STAGE}',
    'Background: one perfectly flat solid {BG_NAME} color ({BG_HEX}) filling the whole image, no gradient, no vignette, no floor, no cast shadow, no reflection.',
    'Exactly one character. No text, no letters, no numbers, no logo, no watermark, no frame, no border.',
    'Original character design; do not imitate any existing cartoon, game, toy line or brand character.',
    'Square image.',
].join(' ');

const WORLD_STYLE = {
    land: 'Natural warm colors; fur suggested by softly sculpted grooves rather than individual hairs.',
    ocean: 'A slight wet glossy sheen on the vinyl with soft aqua highlights.',
    sky: 'Feathers shown as clean layered sculpted shapes, light airy pastel accents.',
    tech: 'An original friendly robot design: glossy enamel-painted panels, visible panel seams, small glowing cyan light strips, rounded safe-looking shapes.',
    prehistoric: 'Earthy natural tones with subtle sculpted stone and fossil-like texture details.',
    fantasy: 'An original fantasy creature with a soft inner glow and gentle iridescent accents.',
};

const RARITY_STYLE = {
    common: 'Plain matte finish, simple calm standing pose, no accessories.',
    rare: 'Wears one small tasteful accessory in sky blue (#4aa3ff), such as a short scarf or a small badge; relaxed confident pose.',
    epic: 'Dynamic action pose with a strong sense of movement; no particles, sparkles or glow around the figure.',
    legendary: 'Majestic heroic pose and fine polished gold trim details on the figure itself; the most impressive figure of the set; no aura, glow, sparkles or particles around the figure.',
};

// 幼年／原型版：只保留稀有度的「物件」特徵，不要英雄姿勢
const RARITY_STYLE_YOUNG = {
    common: 'Plain matte finish, no accessories.',
    rare: 'Wears a smaller, simpler version of a sky blue (#4aa3ff) scarf or badge.',
    epic: 'Playful curious pose; no particles, sparkles or glow around the figure.',
    legendary: 'A few small polished gold trim details on the figure itself; no aura, glow, sparkles or particles around the figure.',
};
// 光暈、粒子等特效一律由程式繪製（可動畫、去背乾淨），圖片裡不要有
const PROPORTIONS = {
    adult: 'Stylized semi-chibi proportions: head about one third of body height.',
    young: 'Strong baby chibi proportions: head about HALF of the total body height, short stubby legs, very round soft body, oversized eyes.',
};
const STAGE_STYLE = {
    adult: 'This is the fully grown, final form of the character.',
    young: {
        animal: 'This is the BABY version of the character. It must look clearly younger and smaller than the adult: change the body proportions and pose; keep only the colors, markings and face features. Do not copy the pose or proportions of any reference image. Any rarity accessory is smaller and simpler.',
        tech: 'This is the early PROTOTYPE version of the robot. It must look clearly smaller and less finished than the final model: more compact boxy body, fewer parts, exposed bolts, wires and one or two unpainted grey panels; keep the color scheme and face design. Do not copy the pose or proportions of any reference image.',
    },
};

// 背景去背色：選與角色主色差最大的那一個（後製時再自動去背）
const KEYS = [{ name: 'magenta', hex: '#FF00FF' }, { name: 'pure green', hex: '#00FF00' }];
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const dist = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));
const RARITY_FX = { common: [], rare: ['#4aa3ff'], epic: [], legendary: ['#ffc83d'] };   // 稀有度特效色也要避開
const pickKey = (art, rarity) => {
    const colors = [...Object.values(art).filter(v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)), ...RARITY_FX[rarity]];
    return KEYS.map(k => ({ k, d: Math.min(...colors.map(c => dist(c, k.hex))) })).sort((a, b) => b.d - a.d)[0].k;
};

// ---------------------------------------------------------------- 角色描述（英文；依編號 01–12）
const SUBJECT = {
    land: [
        'a cat with orange tabby stripes, cream belly and muzzle, pointed ears and a long striped tail',
        'a friendly dog with warm brown fur, a cream chest, floppy ears and a short tail',
        'a capybara with a chunky barrel-shaped body, warm brown fur, a blunt square snout, tiny round ears and a calm relaxed expression',
        'a meerkat standing upright on its hind legs in an alert lookout pose, sandy tan fur, dark eye patches and a thin tail',
        'a three-toed sloth with shaggy grey-brown fur, dark stripes around the eyes, long arms with curved claws and a gentle sleepy smile',
        'a red panda with rusty red fur, white face markings, dark legs and a thick ringed tail',
        'a pangolin covered in large overlapping brown scales, with a long tail and a small pointed snout',
        'a fennec fox with pale cream fur, enormous ears and a fluffy tail with a dark tip',
        'a giraffe with a long neck, a yellow coat with brown patches and two short ossicones on its head',
        'a Formosan black bear with glossy black fur, a clear white V-shaped mark on its chest and round ears',
        'a clouded leopard with golden-tan fur covered in large cloud-shaped dark-edged blotches and a very long thick tail',
        'a snow leopard with smoky white-grey fur, dark rosette spots and an extremely long fluffy tail',
    ],
    ocean: [
        'a clownfish with bright orange scales and three white bands edged in black',
        'a five-armed coral-red sea star with a bumpy textured surface and a cute face in the center',
        'a red-orange hermit crab peeking out of a spiral seashell',
        'a golden-orange seahorse standing upright with a curled tail',
        'a yellow pufferfish inflated into a round ball covered in small soft spikes',
        'a translucent lavender jellyfish with a rounded bell and flowing ribbon tentacles',
        'a green sea turtle with a patterned shell and paddle-shaped flippers, swimming',
        'a pink octopus with eight curling arms showing small suckers',
        'a blue-grey stingray with a flat diamond-shaped body and a long thin tail, gliding',
        'an orca with glossy black and white markings, a white eye patch and a tall dorsal fin',
        'a whale shark with a dark blue-grey body covered in white spots and a wide flat mouth',
        'a blue whale with a long streamlined blue-grey mottled body and throat grooves',
    ],
    sky: [
        'a sparrow with streaked brown wings, a chestnut cap and a small cone-shaped beak',
        'a barn swallow with a glossy dark navy back, a rust-red throat, a cream belly and a deeply forked tail',
        'a white egret with a long neck, a long pointed beak and long thin legs',
        'a green parrot with yellow accents, a hooked beak and a small crest',
        'a grey pigeon with an iridescent green and purple neck',
        'an emerald hummingbird with a magenta throat and a needle-like beak, hovering with motion-blurred wings',
        'a toucan with black feathers, a white throat and a huge bright orange-yellow beak',
        'an owl with brown feathers, a big round facial disc, ear tufts and large eyes',
        'a pink flamingo standing on one leg with a bent beak',
        'a golden eagle with dark brown feathers, golden nape feathers, a hooked yellow beak and spread wings',
        'an albatross with a white body and very long narrow dark grey wings spread wide, gliding',
        'a black frigatebird with an inflated bright red throat pouch, long angular wings and a forked tail',
    ],
    tech: [
        'a four-legged patrol robot dog with light steel-blue panels, yellow accent lights and pointed sensor ears',
        'a round white cleaning robot shaped like a robot vacuum, with cat-ear sensors, small wheels and a cyan light ring',
        'a small cute self-driving car robot with an orange body, dark grey wheels and friendly camera eyes on the windshield',
        'a quadcopter observation drone with four propellers, a light grey body and a green camera eye',
        'a robotic jellyfish with a translucent light-blue metal dome and segmented cable tentacles',
        'a four-legged robot fox with orange armor plates, cream accents, pointed ears and a segmented tail',
        'a six-wheeled exploration rover with blue solar panel wings, a white-grey body and a camera head',
        'a small flying helper robot with a white body, magenta lights, two propellers on top and two small arms',
        'a sleek robot cheetah with yellow armor and dark spot-shaped panels, in a running pose',
        'a mining robot on caterpillar tracks with a grey body, a yellow drill arm and a headlamp',
        'a friendly humanoid city guardian mech with royal blue and white rounded armor and a round shield',
        'a mechanical dragon with steel-grey armor plates, a glowing cyan energy core in its chest and cyan light lines along its wings',
    ],
    prehistoric: [
        'a trilobite with a segmented oval shell divided into three lobes, tan colored, with short antennae',
        'an ammonite with a ridged coiled spiral shell and small tentacles peeking out',
        'a stegosaurus with a green body, two rows of tall back plates and tail spikes',
        'an ankylosaurus with a wide armored body covered in bony plates and a club at the end of its tail',
        'a parasaurolophus with a teal body and a long backward-curving tube crest on its head',
        'a triceratops with three horns and a large bony neck frill',
        'a woolly mammoth with shaggy brown fur, long curved tusks, a trunk and small ears',
        'a pterosaur with leathery wing membranes, a long pointed beak and a backward crest',
        'a mosasaur, a marine reptile with a teal body, paddle flippers and a long toothy jaw, swimming',
        'a brachiosaurus with a very long neck, blue-grey skin and front legs longer than its back legs',
        'a turkey-sized velociraptor covered in rust-red feathers, with a sickle claw on each foot',
        'a tyrannosaurus rex with olive-green skin, a huge head, powerful legs and tiny arms',
    ],
    fantasy: [
        'a small round forest sprite with a soft moss-green body and a leaf sprout on its head',
        'a small sky-blue young dragon with tiny wings, just learning to fly',
        'a white rabbit with a lavender glow, long ears and a small crescent-moon mark on its forehead',
        'an orange forest guardian fox carrying a small glowing lantern, with a fluffy tail',
        'a turtle with glowing teal and ice-blue crystal formations growing on its shell',
        'a gentle whale made of soft white cloud puffs, floating, with a few tiny raindrops falling below it',
        'an indigo deer whose antlers are decorated with tiny glowing stars',
        'a griffin with the head and wings of an eagle and the body of a lion, with softly glowing golden feathers',
        'a white unicorn with a clear crystal horn that splits light into small rainbows and a pastel pink mane',
        'a phoenix with orange-red and gold feathers and a long flowing flame tail',
        'a long teal sky serpent without legs, coiling gracefully among small clouds',
        'an ancient guardian dragon whose scales look like weathered slate-grey stone, with patches of soft green moss and small glowing teal crystals on its back, glowing golden rune lines along its body, long swept-back curved horns, a heavy tail and broad tattered bat-like wings; wise calm eyes; not purple',
    ],
};


// ---------------------------------------------------------------- 場景（2.5D 園區）
// 背景板：一個世界一張寬圖，下方留空地給角色站。道具：去背的小物件，角色可以走到它後面。
const ENV_STYLE = 'Smooth simplified stylized shapes with matte clay-like vinyl materials, soft studio lighting from the top-left with gentle global illumination, so it matches a set of premium collectible vinyl toy figures.';
const NO_LIFE = 'No characters, no animals, no creatures, no robots, no people. No text, no letters, no numbers, no signs with writing, no logos, no watermark, no frame. Original design.';
const BACKDROP = {
    land: ['a sunny forest-edge meadow habitat: rolling green hills, clusters of rounded trees, a winding light dirt path, a small distant pond with reeds, wildflowers, fluffy clouds in a bright blue sky',
        'The lower 35% of the image is an open, mostly flat grassy area with nothing standing on it; its far edge is at about 65% from the top. Trees and hills stay in the upper part and at the far left and right edges.'],
    ocean: ['a bright tropical coral reef underwater habitat: sun rays shining down from the water surface, a gradient from light turquoise at the top to deep blue lower down, distant coral reef silhouettes, a soft sandy sea floor with a few shells',
        'The middle of the image is open water with nothing in it. The sandy sea floor fills the lower 16%, starting at about 84% from the top. Coral and rocks appear only at the far left and right edges and far in the distance.'],
    sky: ['a dreamy high-altitude sky habitat above the clouds: soft pastel sunrise colors (peach, pink, light blue), a sea of fluffy clouds at the bottom, a few small distant floating cloud islands with tiny trees, a gentle sun glow',
        'The central 70% of the image is open sky with nothing in it. The cloud sea fills the lower 14%. Distant floating islands are small and placed near the left and right edges.'],
    tech: ['a friendly futuristic robotics park at dusk: a clean plaza floor with softly glowing cyan grid lines, rounded futuristic buildings with warm lit windows in the distance, a few holographic light panels showing only abstract shapes, a deep navy to purple gradient sky with a few stars',
        'The lower 28% of the image is an open flat plaza floor with nothing on it; its far edge is at about 72% from the top. Buildings stay in the upper part and toward the left and right edges.'],
    prehistoric: ['a lush prehistoric valley: a distant gently smoking volcano, giant ferns and cycad trees, misty cliffs, a calm lake in the middle distance, a warm golden-hour sky',
        'The lower 32% of the image is open, mostly flat earthy ground with low moss and nothing standing on it; its far edge is at about 68% from the top. Tall plants stay at the far left and right edges.'],
    fantasy: ['an enchanted night forest glade: giant softly glowing mushrooms, glowing crystals, ancient trees with small hanging lanterns, a big bright moon, a purple-blue night sky with stars and a faint aurora',
        'The lower 28% of the image is an open mossy ground with nothing standing on it; its far edge is at about 72% from the top. Trees and mushrooms stay at the far left and right edges and in the distance.'],
};
// [檔名 id, 描述, 主要顏色（用來選去背色）]
const PROPS = {
    land: [['land-tree', 'a large round leafy tree with a thick trunk', ['#3f9a4a', '#7a5232']], ['land-bush', 'a round flowering bush with small pink and yellow flowers', ['#4caf50', '#ff7aa2']],
        ['land-rock', 'a mossy grey boulder', ['#9aa3ad', '#6dbb55']], ['land-sign', 'a wooden signpost with a completely blank board', ['#a7794f']], ['land-grass', 'a clump of tall grass with a few wildflowers', ['#6dbb55', '#ffd23f']]],
    ocean: [['ocean-coral', 'a branching coral cluster in pink and orange', ['#ff7a8a', '#ffb347']], ['ocean-kelp', 'a tall wavy kelp plant', ['#2fa36a']],
        ['ocean-rock', 'a rounded rock covered with purple sea anemones', ['#7d8ea3', '#c79bff']], ['ocean-anchor', 'an old weathered anchor half buried in a small pile of sand', ['#8a6a4a', '#f2d9a6']], ['ocean-seagrass', 'a small patch of sea grass with two seashells', ['#3fbf7f', '#ffe2a8']]],
    sky: [['sky-cloud', 'a fluffy white cloud puff', ['#ffffff', '#dbe9ff']], ['sky-island', 'a small floating island of earth and grass with one small tree', ['#6dbb55', '#a7794f']],
        ['sky-balloon', 'an empty small hot-air balloon with a striped envelope and a wicker basket', ['#ff8a2a', '#ffe14d']], ['sky-cloud2', 'a long flat cloud bank', ['#ffffff']]],
    tech: [['tech-crates', 'a stack of futuristic cargo crates with cyan light trim', ['#2e4677', '#00e5ff']], ['tech-lamp', 'a rounded futuristic lamp post with a glowing cyan light', ['#22345f', '#00e5ff']],
        ['tech-charger', 'a round robot charging pad with a small glowing control pillar', ['#d9dee6', '#00e5ff']], ['tech-holo', 'a holographic display pillar showing only abstract glowing shapes', ['#00e5ff', '#5b7cfa']], ['tech-antenna', 'a small antenna tower with blinking lights', ['#8c9aab', '#ff2ec4']]],
    prehistoric: [['pre-fern', 'a giant prehistoric fern', ['#4f7a3a']], ['pre-cycad', 'a cycad palm tree', ['#5c7a3e', '#8a6a4a']], ['pre-fossil', 'a sandstone rock with fossil bones embedded in it', ['#c79a6b', '#efe6d2']],
        ['pre-boulder', 'a dark volcanic boulder with softly glowing orange cracks', ['#3a3a3a', '#ff6a2b']], ['pre-horsetail', 'a cluster of tall prehistoric horsetail plants', ['#7fae5a']]],
    fantasy: [['fan-mushroom', 'a cluster of softly glowing teal mushrooms', ['#7ef9ff', '#efe6ff']], ['fan-crystal', 'a glowing violet crystal cluster', ['#c79bff']],
        ['fan-lantern', 'a small twisted tree with hanging glowing lanterns', ['#5b3a2a', '#ffd23f']], ['fan-runestone', 'a mossy standing stone with glowing golden rune-like patterns that are not letters', ['#7d8494', '#ffd23f']], ['fan-flower', 'a giant softly glowing flower', ['#ff9df0', '#7ef9ff']]],
};
// 全班里程碑（每個世界都會出現）：取代原本共用的彩虹
const MILESTONE_PROPS = [['ms-1', 'a short path of round stepping stones with small glowing stars on them', ['#d9dee6', '#ffe46b']],
    ['ms-2', 'a small arched wooden bridge with rainbow-colored railings', ['#ff6b6b', '#ffd23f', '#4aa3ff', '#8b5a2b']],
    ['ms-3', 'a cozy treehouse in a round leafy tree with a rope ladder', ['#3f9a4a', '#c98a55']],
    ['ms-4', 'a round stone fountain with sparkling water', ['#d9dee6', '#9cd3ff']],
    ['ms-5', 'a small stargazing observatory tower with a telescope on top', ['#d9dee6', '#5b7cfa']],
    ['ms-6', 'a stone class monument with a golden star on top and a completely blank plaque', ['#cfcfcf', '#ffd23f']]];

const pickKeyColors = (colors) => KEYS.map(k => ({ k, d: Math.min(...colors.map(c => dist(c, k.hex))) })).sort((a, b) => b.d - a.d)[0].k;

export const buildEnvironment = () => {
    const out = [];
    for (const w of WORLDS) {
        const [scene, layout] = BACKDROP[w.id];
        out.push({ id: `bg-${w.id}`, type: 'backdrop', world: w.id, file: `art/raw/bg-${w.id}.png`, background: null, referenceImage: null,
            prompt: `A 3D rendered miniature diorama environment: ${scene}. Panoramic wide shot from a slightly elevated eye level, looking straight ahead. ${layout} Subtle tilt-shift depth of field so distant elements are slightly soft. ${ENV_STYLE} Rich but calm colors with lower contrast than the characters, so characters placed in front will stand out. The stage is completely empty. ${NO_LIFE} Wide aspect ratio: 21:9, or the widest the tool supports (at least 16:9), at the highest available resolution.` });
    }
    const prop = (id, world, desc, colors) => {
        const key = pickKeyColors(colors);
        return { id, type: 'prop', world, file: `art/raw/${id}.png`, background: key.hex, referenceImage: null,
            prompt: `A 3D rendered miniature diorama prop: ${desc}. ${ENV_STYLE} The object stands upright, seen from the front at eye level, the whole object visible and centered, filling about 85% of the image height. Background: one perfectly flat solid ${key.name} color (${key.hex}) filling the whole image, no gradient, no floor, no cast shadow, no reflection. Exactly one object. ${NO_LIFE} Square image.` };
    };
    for (const w of WORLDS) for (const [id, desc, colors] of PROPS[w.id]) out.push(prop(id, w.id, desc, colors));
    for (const [id, desc, colors] of MILESTONE_PROPS) out.push(prop(id, null, desc, colors));
    return out;
};

// 執行順序（數字小的先做）：1 重測 → 2 背景板 → 3 成年角色 → 4 道具與里程碑 → 5 幼年角色
const RETEST = new Set(['fantasy-12_adult', 'land-01_young', 'ocean-07_young', 'tech-10_young', 'fantasy-12_young']);
export const priorityOf = (p) => p.type === 'backdrop' ? 2 : p.type === 'prop' ? 4 : RETEST.has(`${p.id}_${p.stage}`) ? 1 : p.stage === 'adult' ? 3 : 5;

// 試作樣本：四個稀有度、四個不同世界
export const SAMPLES = ['land-01', 'ocean-07', 'tech-10', 'fantasy-12'];

export const buildPrompts = () => CATALOG.flatMap(it => {
    const desc = SUBJECT[it.world]?.[it.no - 1];
    if (!desc) throw new Error(`缺少角色描述：${it.id}`);
    const key = pickKey(it.art, it.rarity);
    const base = (stage) => STYLE
        .replace('{SUBJECT}', desc).replace('{PROPORTIONS}', PROPORTIONS[stage]).replace('{WORLD}', WORLD_STYLE[it.world]).replace('{RARITY}', (stage === 'adult' ? RARITY_STYLE : RARITY_STYLE_YOUNG)[it.rarity])
        .replace('{STAGE}', stage === 'adult' ? STAGE_STYLE.adult : STAGE_STYLE.young[it.track === 'tech' ? 'tech' : 'animal'])
        .replace('{BG_NAME}', key.name).replace('{BG_HEX}', key.hex);
    return ['adult', 'young'].map(stage => ({
        id: it.id, type: 'character', name: it.name, world: it.world, no: it.no, rarity: it.rarity, stage,
        file: `art/raw/${it.id}_${stage}.png`,
        background: key.hex,
        referenceImage: stage === 'young' ? `art/raw/${it.id}_adult.png` : null,
        sample: SAMPLES.includes(it.id),
        prompt: base(stage),
    }));
});

const main = async () => {
    const list = [...buildPrompts(), ...buildEnvironment()].map(p => ({ ...p, priority: priorityOf(p) }));
    await mkdir(resolve(root, 'art/prompts'), { recursive: true });
    await writeFile(resolve(root, 'art/prompts/prompts.json'), JSON.stringify({ version: 2, style: 'collectible-vinyl-figure', samples: SAMPLES, count: list.length, items: list }, null, 2) + '\n');
    const rName = new Map(RARITIES.map(r => [r.id, r.name]));
    const md = ['# FHES 圖鑑角色提示詞（自動產生，勿手改）', '', '由 `node scripts/art-prompts.mjs` 產生；規範見 `docs/ART-DIRECTION.md`，執行流程見 `art/ANTIGRAVITY-TASK.md`。', ''];
    for (const w of WORLDS) {
        md.push(`## ${w.icon} ${w.name}`, '');
        for (const p of list.filter(x => x.type === 'character' && x.world === w.id)) {
            md.push(`### ${p.id} ${p.name}（${rName.get(p.rarity)}・${p.stage === 'adult' ? '成年／完工' : '幼年／原型'}）${p.sample ? ' ★ 試作樣本' : ''}`, '',
                `- 檔名：\`${p.file}\``, `- 背景色：\`${p.background}\``, ...(p.referenceImage ? [`- 參考圖：\`${p.referenceImage}\`（同一角色，必須附上）`] : []), '', '```', p.prompt, '```', '');
        }
    }
    md.push('## 🏞️ 園區背景板與道具', '');
    for (const p of list.filter(x => x.type !== 'character')) {
        md.push(`### ${p.id}（${p.type === 'backdrop' ? '背景板' : '道具'}）`, '', `- 檔名：\`${p.file}\``, ...(p.background ? [`- 背景色：\`${p.background}\``] : ['- 背景：完整場景，不去背']), '', '```', p.prompt, '```', '');
    }
    await writeFile(resolve(root, 'art/prompts/PROMPTS.md'), md.join('\n'));
    const n = (t) => list.filter(x => x.type === t).length;
    console.log(`已產生 ${list.length} 條提示詞：角色 ${n('character')}、背景板 ${n('backdrop')}、道具 ${n('prop')}`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
