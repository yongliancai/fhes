# 圖鑑美術後製：art/raw/*.png → assets/creatures/*.webp ＋ src/data/art-manifest.js
# 角色與道具：純色背景去背；背景板（bg-<世界>）：裁成 20:9，不去背。
# 只處理 art/approved.json 列出的圖（人工核准才會上架）。
# 用法：python scripts/art-process.py   （需要 Pillow：pip install pillow）
import json, sys
from pathlib import Path
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'art' / 'raw'
OUT = ROOT / 'assets' / 'creatures'
MANIFEST = ROOT / 'src' / 'data' / 'art-manifest.js'
SIZE = 512          # 角色／道具輸出邊長（園區最大顯示約 300px，2x 螢幕夠用）
BG_W = 1920         # 背景板寬度（20:9）
PAD = 0.04          # 角色外圍留白比例


def key_color(img):
    """背景色取四個角落的中位數（AI 給的「純綠」常不是真正的 #00FF00）"""
    w, h = img.size
    pts = [(4, 4), (w - 5, 4), (4, h - 5), (w - 5, h - 5), (w // 2, 4), (4, h // 2), (w - 5, h // 2)]
    cols = [img.getpixel(p)[:3] for p in pts]
    return tuple(sorted(c[i] for c in cols)[len(cols) // 2] for i in range(3))


def remove_bg(img, key):
    """色度去背：與背景色的距離決定透明度（柔邊），並抑制邊緣的背景色溢色"""
    img = img.convert('RGBA')
    px = img.load()
    w, h = img.size
    kr, kg, kb = key
    green = kg > kr and kg > kb
    lo, hi = 70, 150                   # 距離 < lo 全透明，> hi 全不透明
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            d = ((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2) ** 0.5
            if d <= lo:
                px[x, y] = (0, 0, 0, 0)
                continue
            alpha = 255 if d >= hi else int(255 * (d - lo) / (hi - lo))
            # 去溢色：綠底壓低多出來的綠；洋紅底壓低多出來的紅藍
            if green and g > max(r, b):
                g = max(r, b)
            elif not green and min(r, b) > g:
                r = b = max(g, min(r, b) - (min(r, b) - g) // 2)
            px[x, y] = (r, g, b, alpha)
    # 收掉最外圈 1px 半透明殘邊
    a = img.getchannel('A').filter(ImageFilter.MinFilter(3))
    img.putalpha(a)
    return img


def fit_square(img):
    box = img.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
    if not box:
        raise ValueError('整張圖都被去掉了，請檢查背景色')
    img = img.crop(box)
    side = int(max(img.size) * (1 + PAD * 2))
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    # 腳底貼齊下緣（園區以腳底定位），水平置中
    canvas.paste(img, ((side - img.width) // 2, side - img.height - int(side * PAD)), img)
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def fit_prop(img):
    """道具：裁到物件邊界、保留原比例、底部貼齊（園區以底部定位），高度 512"""
    box = img.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
    if not box:
        raise ValueError('整張圖都被去掉了，請檢查背景色')
    img = img.crop(box)
    hgt = SIZE
    wid = max(1, round(img.width * hgt / img.height))
    return img.resize((wid, hgt), Image.LANCZOS)


def fit_backdrop(img):
    """背景板：裁成 20:9（置中、偏下保留地面），寬 1920"""
    w, h = img.size
    tw, th = (w, round(w * 9 / 20)) if w / h < 20 / 9 else (round(h * 20 / 9), h)
    left = (w - tw) // 2
    top = min(h - th, max(0, round((h - th) * 0.7)))   # 裁切時多保留下方（角色站的地面）
    img = img.crop((left, top, left + tw, top + th))
    return img.resize((BG_W, round(BG_W * 9 / 20)), Image.LANCZOS)


def kind_of(name):
    if name.startswith('bg-'):
        return 'backdrop'
    if '_' in name and name.rsplit('_', 1)[1] in ('adult', 'young'):
        return 'character'
    return 'prop'


def main():
    approved = json.loads((ROOT / 'art' / 'approved.json').read_text(encoding='utf-8'))['approved']
    OUT.mkdir(parents=True, exist_ok=True)
    assets, backdrops, props = {}, [], {}
    for name in approved:
        kind = kind_of(name)
        src = RAW / f'{name}.png'
        dst = OUT / f'{name}.webp'
        if src.exists():
            img = Image.open(src).convert('RGB')
            if kind == 'backdrop':
                out = fit_backdrop(img)
                out.save(dst, 'WEBP', quality=80, method=6)
            else:
                cut = remove_bg(img, key_color(img))
                out = fit_square(cut) if kind == 'character' else fit_prop(cut)
                out.save(dst, 'WEBP', quality=86, method=6)
            print(f'{name}: {dst.stat().st_size // 1024} KB')
        elif not dst.exists():
            print(f'略過（找不到原始檔）：{src.relative_to(ROOT)}', file=sys.stderr)
            continue
        if kind == 'character':
            cid, stage = name.rsplit('_', 1)
            assets.setdefault(cid, []).append(stage)
        elif kind == 'backdrop':
            backdrops.append(name[3:])
        else:
            with Image.open(dst) as im:
                props[name] = round(im.width / im.height, 3)
    lines = ['// 自動產生（scripts/art-process.py），勿手改：已核准並完成後製的圖片。',
             '// ART_ASSETS：收藏 ID → 可用階段（adult／young）。BACKDROPS：有背景板的世界。PROPS：道具 ID → 寬高比。',
             'export const ART_ASSETS = Object.freeze({']
    for cid in sorted(assets):
        lines.append(f"    '{cid}': Object.freeze({json.dumps(sorted(set(assets[cid])))}),")
    lines.append('});')
    lines.append(f"export const BACKDROPS = Object.freeze({json.dumps(sorted(backdrops))});")
    lines.append('export const PROPS = Object.freeze({')
    for pid in sorted(props):
        lines.append(f"    '{pid}': {props[pid]},")
    lines.append('});')
    MANIFEST.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'manifest：角色 {len(assets)}、背景板 {len(backdrops)}、道具 {len(props)}')


if __name__ == '__main__':
    main()
