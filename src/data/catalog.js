// 六大收藏世界的基本圖鑑（固定 72 項；ID 一經發布不可更改）。
//
// confirm（確認狀態，依《3.0 計劃書》第 3、6 節）：
//   'U'  = 使用者已確認角色與稀有度
//   'UE' = 使用者已確認角色；稀有度為專家定案建議
//   'E'  = 專家定案建議（非使用者親自批准，可再調整）
// 稀有度是遊戲內的收藏定位，不代表現實物種的保育等級，也不代表學生的能力。
// art：目前全部是程式產生的「原創佔位插畫」（src/art/creatures.js），正式美術待製作；授權紀錄見 docs/ASSET-LICENSES.md。

export const WORLDS = Object.freeze([
    { id: 'land', name: '陸地', group: '自然', icon: '🌳', tagline: '森林與草原的生態探索' },
    { id: 'ocean', name: '海洋', group: '自然', icon: '🌊', tagline: '珊瑚礁與深海' },
    { id: 'sky', name: '天空', group: '自然', icon: '☁️', tagline: '雲層與樹冠的飛行者' },
    { id: 'tech', name: '科技', group: '特殊', icon: '⚙️', tagline: '原創機械夥伴（虛構設定）' },
    { id: 'prehistoric', name: '史前', group: '特殊', icon: '🦴', tagline: '化石與古生物科普' },
    { id: 'fantasy', name: '奇幻', group: '特殊', icon: '✨', tagline: '原創奇幻生物（虛構設定）' },
]);

/** 稀有度：顏色＋圖示＋文字，三者並用（不能只靠顏色辨識） */
export const RARITIES = Object.freeze([
    { id: 'common', name: '普通', icon: '●', color: '#8fbf9f', rank: 0 },
    { id: 'rare', name: '稀有', icon: '◆', color: '#4aa3ff', rank: 1 },
    { id: 'epic', name: '史詩', icon: '★', color: '#b06cff', rank: 2 },
    { id: 'legendary', name: '傳說', icon: '♛', color: '#ffc83d', rank: 3 },
]);
export const RARITY_QUOTA = Object.freeze({ common: 5, rare: 4, epic: 2, legendary: 1 });

const R = ['common', 'common', 'common', 'common', 'common', 'rare', 'rare', 'rare', 'rare', 'epic', 'epic', 'legendary'];
/** [名稱, 確認, 成長路線, 知識卡, 美術參數] — 依編號 01–12，稀有度依 R 固定 */
const DEF = {
    land: [
        ['貓咪', 'UE', 'animal', '貓咪的鬍鬚能感覺空氣流動，幫助牠在暗處判斷空間。', { p: 'land', c: '#f2b46d', a: '#fff1dc', ears: 'pointy', tail: 'long', pat: 'stripes' }],
        ['狗狗', 'UE', 'animal', '狗的嗅覺非常靈敏，能靠氣味認出熟悉的人。', { p: 'land', c: '#c98a55', a: '#fbe6cf', ears: 'floppy', tail: 'short' }],
        ['水豚', 'U', 'animal', '水豚是世界上最大的囓齒動物，很會游泳。', { p: 'land', c: '#a77a52', a: '#d8b58f', ears: 'tiny', tail: 'none', snout: 'wide' }],
        ['狐獴', 'U', 'animal', '狐獴會輪流站崗，看到天敵就發出警告聲。', { p: 'upright', c: '#d9b98c', a: '#f4e3c8', ears: 'tiny', tail: 'thin', mask: true }],
        ['樹懶', 'U', 'animal', '樹懶動作很慢，大部分時間倒掛在樹上休息。', { p: 'land', c: '#9c8a72', a: '#d9ccb6', ears: 'none', tail: 'none', mask: true, smile: true }],
        ['小貓熊', 'E', 'animal', '小貓熊（紅貓熊）住在高山森林，很愛吃竹子。', { p: 'land', c: '#c8582b', a: '#fff1e2', ears: 'pointy', tail: 'ring', mask: true }],
        ['穿山甲', 'E', 'animal', '穿山甲全身有鱗片，遇到危險會捲成一顆球；臺灣也有野生穿山甲。', { p: 'land', c: '#8f6e4c', a: '#c9a87e', ears: 'none', tail: 'long', pat: 'scales' }],
        ['耳廓狐', 'E', 'animal', '耳廓狐的大耳朵能幫忙散熱，適合住在沙漠。', { p: 'land', c: '#efd3a6', a: '#fff7ea', ears: 'huge', tail: 'fluffy' }],
        ['長頸鹿', 'UE', 'animal', '長頸鹿是最高的陸地動物，舌頭很長，能吃到高處的樹葉。', { p: 'land', c: '#f0c35a', a: '#fbe7b4', ears: 'small', tail: 'thin', pat: 'patches', neck: true, ossicones: true }],
        ['臺灣黑熊', 'U', 'animal', '臺灣黑熊胸前有 V 字形白色斑紋，是臺灣特有亞種。', { p: 'land', c: '#2d2a2e', a: '#5b5359', ears: 'round', tail: 'none', vmark: true }],
        ['雲豹', 'U', 'animal', '雲豹身上有像雲朵的斑紋，很會爬樹。', { p: 'land', c: '#c9a46a', a: '#efdcb8', ears: 'round', tail: 'long', pat: 'clouds' }],
        ['雪豹', 'U', 'animal', '雪豹住在高山雪地，長長的尾巴能保暖、幫助平衡。', { p: 'land', c: '#e6e9ee', a: '#ffffff', ears: 'round', tail: 'fluffy', pat: 'rosettes' }],
    ],
    ocean: [
        ['小丑魚', 'E', 'animal', '小丑魚住在海葵裡，海葵保護牠，牠也幫海葵清潔。', { p: 'fish', c: '#ff8a2a', a: '#ffffff', pat: 'bands' }],
        ['海星', 'E', 'animal', '海星的腕斷掉後，有機會慢慢再長出來。', { p: 'star', c: '#ff7a6b', a: '#ffc3a8' }],
        ['寄居蟹', 'E', 'animal', '寄居蟹會借用空貝殼當家，長大後就換更大的殼。', { p: 'crab', c: '#e8603c', a: '#f6d7b0', shell: true }],
        ['海馬', 'E', 'animal', '海馬是由爸爸在育兒袋裡照顧寶寶。', { p: 'seahorse', c: '#ffb347', a: '#ffe2a8' }],
        ['河豚', 'E', 'animal', '河豚遇到危險會吸水把身體脹成圓球。', { p: 'fish', c: '#e7d27c', a: '#fff8dc', round: true, spikes: true }],
        ['水母', 'E', 'animal', '水母沒有大腦和骨頭，身體大部分是水。', { p: 'jelly', c: '#c79bff', a: '#f0e3ff' }],
        ['海龜', 'E', 'animal', '海龜會游很遠的路，回到出生的海灘產卵。', { p: 'turtle', c: '#5fae6e', a: '#a7d98b' }],
        ['章魚', 'E', 'animal', '章魚有八條腕，還能改變身體顏色來躲藏。', { p: 'octopus', c: '#e86a8a', a: '#ffc2d1' }],
        ['魟魚', 'E', 'animal', '魟魚身體扁平，像在水中「飛」一樣游泳。', { p: 'ray', c: '#6f8fa8', a: '#e6eef5' }],
        ['虎鯨', 'E', 'animal', '虎鯨是群體生活的海洋哺乳動物，會一起合作找食物。', { p: 'whale', c: '#1f2630', a: '#ffffff', orca: true }],
        ['鯨鯊', 'E', 'animal', '鯨鯊是世界上最大的魚，卻主要吃很小的浮游生物。', { p: 'fish', c: '#46617d', a: '#dfe9f2', pat: 'dots', big: true }],
        ['藍鯨', 'E', 'animal', '藍鯨是地球上已知最大的動物。', { p: 'whale', c: '#4f7fb8', a: '#cfe0f5' }],
    ],
    sky: [
        ['麻雀', 'E', 'animal', '麻雀常在住家附近活動，喜歡成群吃種子。', { p: 'bird', c: '#a7794f', a: '#efe0c8', beak: 'small' }],
        ['燕子', 'E', 'animal', '燕子會用泥土築巢，飛行時能在空中捕捉小蟲。', { p: 'bird', c: '#24324f', a: '#f5efe6', beak: 'small', fork: true, throat: '#c9553a' }],
        ['白鷺鷥', 'E', 'animal', '白鷺鷥常在田裡或水邊找小魚、小蟲吃。', { p: 'bird', c: '#f7f7f2', a: '#ffffff', beak: 'long', legs: 'long' }],
        ['鸚鵡', 'E', 'animal', '有些鸚鵡能模仿聲音，腳趾兩前兩後適合抓握。', { p: 'bird', c: '#3cc46a', a: '#ffe14d', beak: 'hook', crest: true }],
        ['鴿子', 'E', 'animal', '鴿子有很好的方向感，以前曾被用來送信。', { p: 'bird', c: '#9aa3b2', a: '#c7d0dd', beak: 'small', throat: '#7fb59a' }],
        ['蜂鳥', 'E', 'animal', '蜂鳥能在空中停住不動，還能往後飛。', { p: 'bird', c: '#36b39a', a: '#e8fff6', beak: 'needle', tiny: true, throat: '#e0447a' }],
        ['巨嘴鳥', 'E', 'animal', '巨嘴鳥的大嘴看起來重，其實很輕，也能幫忙散熱。', { p: 'bird', c: '#1c1c22', a: '#fff3c4', beak: 'toucan' }],
        ['貓頭鷹', 'E', 'animal', '貓頭鷹多在夜間活動，頭能轉很大的角度。', { p: 'bird', c: '#8a6a4a', a: '#e8d4b4', beak: 'hook', owl: true }],
        ['紅鶴', 'E', 'animal', '紅鶴的粉紅色來自牠吃的食物中的色素。', { p: 'bird', c: '#ff8fb1', a: '#ffd6e3', beak: 'bent', legs: 'long' }],
        ['金雕', 'E', 'animal', '金雕是大型猛禽，視力非常好。', { p: 'bird', c: '#6b4a2b', a: '#d9a441', beak: 'hook', big: true }],
        ['信天翁', 'E', 'animal', '信天翁翅膀很長，能乘著海風滑翔很久。', { p: 'bird', c: '#ffffff', a: '#3b4350', beak: 'long', wide: true }],
        ['軍艦鳥', 'E', 'animal', '雄軍艦鳥求偶時會鼓起紅色的喉囊。', { p: 'bird', c: '#20232b', a: '#3a3f4b', beak: 'hook', pouch: true, wide: true }],
    ],
    tech: [
        ['巡邏機器狗', 'E', 'tech', '四隻腳的機器人比輪子更容易走樓梯和不平的路。', { p: 'robot', c: '#9fb3c8', a: '#ffd23f', legs: 4, ears: 'pointy' }],
        ['清潔機器貓', 'E', 'tech', '掃地機器人會用感測器記錄房間形狀，規劃清掃路線。', { p: 'robot', c: '#e7edf4', a: '#00e5ff', wheels: true, ears: 'cat' }],
        ['自走車', 'E', 'tech', '自走車用攝影機和感測器「看」路，再由程式決定怎麼轉彎。', { p: 'robot', c: '#ffb347', a: '#4a5568', wheels: true, car: true }],
        ['觀察無人機', 'E', 'tech', '無人機靠多個螺旋槳調整轉速，就能在空中停住或轉向。', { p: 'robot', c: '#cfd8e3', a: '#39ff88', props: true }],
        ['機械水母', 'E', 'tech', '科學家研究水母的游泳方式，設計更省電的水下機器人。', { p: 'jelly', c: '#7fd3ff', a: '#e5f7ff', metal: true }],
        ['機械狐狸', 'E', 'tech', '仿生機器人模仿動物的動作，讓機器更靈活。', { p: 'robot', c: '#ff8a3d', a: '#ffe3c7', legs: 4, ears: 'pointy', tail: true }],
        ['太陽能探測車', 'E', 'tech', '探測車用太陽能板發電，可以到很遠的地方探險。', { p: 'robot', c: '#d9dee6', a: '#2f6fd6', wheels: true, panel: true }],
        ['飛行助手', 'E', 'tech', '小型飛行器可以協助搜救，飛到人不容易到的地方。', { p: 'robot', c: '#ffffff', a: '#ff2ec4', props: true, arms: true }],
        ['機械獵豹', 'E', 'tech', '研究獵豹奔跑的姿勢，可以讓機器人跑得又快又穩。', { p: 'robot', c: '#ffd23f', a: '#2d2a2e', legs: 4, ears: 'round', tail: true, spots: true }],
        ['智慧探勘機', 'E', 'tech', '探勘機器人能進入危險的洞穴或礦坑，替人類收集資料。', { p: 'robot', c: '#8c9aab', a: '#ffd23f', wheels: true, drill: true, arms: true }],
        ['城市守護機甲', 'E', 'tech', '大型機器需要很多人合作設計：機構、電路、程式缺一不可。', { p: 'robot', c: '#5b7cfa', a: '#ffffff', mech: true, arms: true }],
        ['核心機械龍', 'E', 'tech', '這是班級幻想的終極發明！想想看：你會幫它設計什麼功能？', { p: 'dragon', c: '#7a8ca3', a: '#00e5ff', metal: true }],
    ],
    prehistoric: [
        ['三葉蟲', 'E', 'animal', '三葉蟲是古老的海洋節肢動物，常在化石中被發現。', { p: 'trilobite', c: '#a08c74', a: '#d6c6ad' }],
        ['菊石', 'E', 'animal', '菊石是有螺旋外殼的古代海洋動物，和章魚、烏賊是親戚。', { p: 'ammonite', c: '#c79a6b', a: '#f2dcc0' }],
        ['劍龍', 'E', 'animal', '劍龍背上有大骨板，尾巴有尖刺可以防身。', { p: 'dino', c: '#7fae5a', a: '#cfe6a8', plates: true, spikes: true }],
        ['甲龍', 'E', 'animal', '甲龍全身像穿盔甲，尾巴末端有骨錘。', { p: 'dino', c: '#8a7a5a', a: '#cbbd98', armor: true, club: true }],
        ['副櫛龍', 'E', 'animal', '副櫛龍頭上有長長的冠，可能用來發出聲音。', { p: 'dino', c: '#5fa3a0', a: '#bfe3d6', crest: true }],
        ['三角龍', 'E', 'animal', '三角龍頭上有三根角和一個大頸盾。', { p: 'dino', c: '#b07a4a', a: '#ead2a8', horns: true, frill: true }],
        ['猛獁象', 'E', 'animal', '猛獁象是冰河時期的長毛象，不是恐龍，是哺乳動物。', { p: 'land', c: '#7a5232', a: '#a87a52', ears: 'round', tail: 'thin', tusks: true, fur: true, trunk: true }],
        ['翼龍', 'E', 'animal', '翼龍會飛，但牠不是恐龍，是恐龍的近親爬行動物。', { p: 'bird', c: '#c0845a', a: '#efc9a2', beak: 'long', crest: true, membrane: true }],
        ['滄龍', 'E', 'animal', '滄龍是住在海裡的大型爬行動物，也不是恐龍。', { p: 'whale', c: '#3d6f7a', a: '#bfe0dc', reptile: true }],
        ['腕龍', 'E', 'animal', '腕龍脖子很長，可以吃到高高的樹葉。', { p: 'dino', c: '#7d9bb8', a: '#cfe0ee', longneck: true }],
        ['迅猛龍', 'E', 'animal', '真正的迅猛龍體型大約像火雞，而且身上可能有羽毛。', { p: 'dino', c: '#a35d3a', a: '#f0c7a0', feathers: true, biped: true }],
        ['暴龍', 'E', 'animal', '暴龍是大型肉食恐龍，咬合力非常強。', { p: 'dino', c: '#5c7a3e', a: '#b8d38f', biped: true, big: true }],
    ],
    fantasy: [
        ['苔蘚精靈', 'E', 'animal', '傳說它會在下雨後的森林裡，幫小苗蓋上綠色的被子。', { p: 'sprite', c: '#7fcf6a', a: '#e6ffd6', leaf: true }],
        ['小飛龍', 'E', 'animal', '剛學會飛的小龍，最喜歡跟著好朋友一起練習。', { p: 'dragon', c: '#7ad1ff', a: '#e8f8ff', small: true }],
        ['月光兔', 'E', 'animal', '只在月光下出現，會把大家的願望收進口袋。', { p: 'land', c: '#f4f1ff', a: '#ffffff', ears: 'bunny', tail: 'puff', glow: '#cdd6ff' }],
        ['森林守護狐', 'E', 'animal', '守護森林小路的狐狸，會為迷路的人點亮小燈。', { p: 'land', c: '#e07a3a', a: '#fff3e6', ears: 'pointy', tail: 'fluffy', lantern: true }],
        ['晶石龜', 'E', 'animal', '背上的晶石會隨心情變色，提醒大家說出自己的感受。', { p: 'turtle', c: '#6db38a', a: '#c6f0ff', crystals: true }],
        ['雲朵鯨', 'E', 'animal', '在天空悠游的大鯨魚，經過的地方會下起溫柔的小雨。', { p: 'whale', c: '#ffffff', a: '#dfe9ff', cloud: true }],
        ['星河鹿', 'E', 'animal', '鹿角上掛著小星星，晚上會替旅人指引方向。', { p: 'land', c: '#5b6cc9', a: '#dfe4ff', ears: 'small', tail: 'short', antlers: true, stars: true }],
        ['光羽獅鷲', 'E', 'animal', '一半像鷹、一半像獅的守護者，羽毛會發出微光。', { p: 'land', c: '#e8c068', a: '#ffffff', ears: 'small', tail: 'long', wings: true, beakFace: true }],
        ['水晶獨角獸', 'E', 'animal', '角是透明的水晶，能把陽光變成彩虹。', { p: 'land', c: '#fbf7ff', a: '#ffd6f5', ears: 'small', tail: 'fluffy', horn: true, mane: true }],
        ['鳳凰', 'E', 'animal', '傳說中的火鳥，象徵重新出發與勇氣。', { p: 'bird', c: '#ff6a2b', a: '#ffd23f', beak: 'hook', crest: true, fire: true, big: true }],
        ['天空巨蛇', 'E', 'animal', '盤旋在雲層上的巨蛇，守護著天空之門。', { p: 'serpent', c: '#3fb6a8', a: '#d8fff6' }],
        ['遠古守護龍', 'E', 'animal', '最古老的守護龍，只會出現在團結合作的班級。', { p: 'dragon', c: '#8a5cff', a: '#ffd23f', big: true }],
    ],
};

/** 成長路線：生物與機械各自的四個階段（成長不改變稀有度） */
export const GROWTH_TRACKS = Object.freeze({
    animal: ['發現', '初成長', '成熟', '完成紀錄'],
    tech: ['發現', '組裝', '升級', '完工'],
});

export const CATALOG = Object.freeze(WORLDS.flatMap(w => DEF[w.id].map(([name, confirm, track, fact, art], i) => Object.freeze({
    id: `${w.id}-${String(i + 1).padStart(2, '0')}`, world: w.id, no: i + 1, name, rarity: R[i], confirm, track, fact, art: Object.freeze(art),
    artStatus: 'placeholder',
}))));

export const catalogById = new Map(CATALOG.map(c => [c.id, c]));
export const rarityById = new Map(RARITIES.map(r => [r.id, r]));
export const worldById = new Map(WORLDS.map(w => [w.id, w]));
export const CONFIRM_LABEL = Object.freeze({ U: '使用者已確認', UE: '角色已確認；稀有度為專家建議', E: '專家定案建議' });
