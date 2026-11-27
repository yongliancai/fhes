# Asset licence ledger

Every visual asset shipped by the app is listed here with its origin and licence. No third-party image files are used.

| Asset | Location | Origin | Licence / status |
|---|---|---|---|
| 72 base collectible characters | `src/art/creatures.js` (parametric SVG built at runtime) | Original code written for this project (2026-11-24). Shapes are generic geometric primitives (circles, ellipses, paths); no tracing or copying of existing artwork or of any known game/franchise character. | Project-owned. **Status: placeholder (原創佔位插畫，待美術定稿)** — shown as such in the UI. |
| Special-collection look | same generator, re-using the base item's spec | Original | Project-owned, placeholder |
| Six habitat scenes + 6 class-milestone decorations | `src/art/scenes.js` (SVG) | Original code written for this project | Project-owned, placeholder |
| Emoji used as icons (🌳 🌊 ☁️ ⚙️ 🦴 ✨ 🎉 …) | UI text | Unicode characters rendered by the viewer's system emoji font | Rendered by the OS; no image files are bundled |
| Fonts Orbitron, Rajdhani, Share Tech Mono | loaded from Google Fonts (existing v5.1 behaviour) | Google Fonts | SIL Open Font License 1.1 |
| Sound effects | Web Audio synthesis in `index.html` (existing v5.1) | Generated at runtime | No audio files |

## Character content provenance
- Land-world roster and rarities: confirmed by the user (see `src/data/catalog.js`, `confirm: 'U'`/`'UE'`).
- Ocean / Sky / Tech / Prehistoric / Fantasy rosters: expert proposals from the 3.0 design document (`confirm: 'E'`), **not** individually approved by the user; teacher can review and adjust.
- Tech and Fantasy characters are original fictional designs (e.g. 巡邏機器狗, 苔蘚精靈). Generic mythological concepts (dragon, phoenix, unicorn, griffin) are public-domain ideas; the visual designs are original.
- Fact cards are written for this project in plain language for primary-school pupils; prehistoric cards explicitly note that 翼龍, 滄龍 and 猛獁象 are not dinosaurs.

## Before replacing placeholders with final illustrations
1. Record artist / tool, creation date, licence (or work-for-hire agreement) for each file in this table.
2. If generative AI tools are used, record the tool, prompt and the tool's commercial-use terms; check the result does not imitate an existing franchise character.
3. Keep stable item IDs (`land-01` …); only the art reference changes.

## Bundled code

| Code | Location | Origin | Licence |
|---|---|---|---|
| QR Code encoder (byte mode, error correction level M, versions 1–10) | `src/vendor/qr.js` | Written for this project (2026-11-27) from the ISO/IEC 18004 algorithm. Its structure (Reed–Solomon divisor and remainder, block interleaving, function patterns, mask penalty) follows Project Nayuki's "QR Code generator library". It is bundled because the teacher page's CSP does not load scripts from a CDN. | Project Nayuki's library is MIT-licensed: "Copyright © Project Nayuki. Permission is hereby granted, free of charge, to any person obtaining a copy of this software… THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND." (MIT License, https://www.nayuki.io/page/qr-code-generator-library). Tested by `tests/qr.test.mjs` (round trip through an independent reader + published reference values). |
