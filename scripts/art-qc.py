# FHES v6.2 候選圖自動技術品質檢查與候選 WebP 後製（不修改 art/approved.json 與 src/data/art-manifest.js）
# 用法：python scripts/art-qc.py <key> [--raw art/raw/<key>.png] [--out-dir assets/candidates]
import hashlib
import json
import sys
from pathlib import Path
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / 'art' / 'raw'
CANDIDATE_OUT = ROOT / 'assets' / 'candidates'
SIZE = 512
BG_W = 1920
PAD = 0.04


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def kind_of(name: str) -> str:
    if name.startswith('bg-'):
        return 'backdrop'
    if '_' in name and name.rsplit('_', 1)[1] in ('adult', 'young'):
        return 'character'
    return 'prop'


def key_color_stats(img: Image.Image):
    w, h = img.size
    pts = [
        (4, 4), (w - 5, 4), (4, h - 5), (w - 5, h - 5),
        (w // 2, 4), (4, h // 2), (w - 5, h // 2), (w // 2, h - 5),
    ]
    cols = [img.getpixel(p)[:3] for p in pts]
    median = tuple(sorted(c[i] for c in cols)[len(cols) // 2] for i in range(3))
    max_dev = max(
        ((c[0] - median[0]) ** 2 + (c[1] - median[1]) ** 2 + (c[2] - median[2]) ** 2) ** 0.5
        for c in cols
    )
    return median, round(max_dev, 2)


def remove_bg(img: Image.Image, key):
    rgba = img.convert('RGBA')
    px = rgba.load()
    w, h = rgba.size
    kr, kg, kb = key
    green = kg > kr and kg > kb
    lo, hi = 70, 150
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            d = ((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2) ** 0.5
            if d <= lo:
                px[x, y] = (0, 0, 0, 0)
                continue
            alpha = 255 if d >= hi else int(255 * (d - lo) / (hi - lo))
            if green and g > max(r, b):
                g = max(r, b)
            elif not green and min(r, b) > g:
                r = b = max(g, min(r, b) - (min(r, b) - g) // 2)
            px[x, y] = (r, g, b, alpha)
    a = rgba.getchannel('A').filter(ImageFilter.MinFilter(3))
    rgba.putalpha(a)
    return rgba


def fit_square(img: Image.Image):
    box = img.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
    if not box:
        raise ValueError('empty_cutout')
    cropped = img.crop(box)
    side = int(max(cropped.size) * (1 + PAD * 2))
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(cropped, ((side - cropped.width) // 2, side - cropped.height - int(side * PAD)), cropped)
    return canvas.resize((SIZE, SIZE), Image.LANCZOS), box


def fit_prop(img: Image.Image):
    box = img.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
    if not box:
        raise ValueError('empty_cutout')
    cropped = img.crop(box)
    hgt = SIZE
    wid = max(1, round(cropped.width * hgt / cropped.height))
    return cropped.resize((wid, hgt), Image.LANCZOS), box


def fit_backdrop(img: Image.Image):
    w, h = img.size
    tw, th = (w, round(w * 9 / 20)) if w / h < 20 / 9 else (round(h * 20 / 9), h)
    left = (w - tw) // 2
    top = min(h - th, max(0, round((h - th) * 0.7)))
    cropped = img.crop((left, top, left + tw, top + th))
    return cropped.resize((BG_W, round(BG_W * 9 / 20)), Image.LANCZOS), (left, top, left + tw, top + th)


def inspect_and_process(key: str, raw_path: Path, out_dir: Path):
    kind = kind_of(key)
    issues = []
    warnings = []
    if not raw_path.exists():
        return {'key': key, 'kind': kind, 'technical_status': 'qc_fail', 'issues': ['missing_raw_file'], 'manual_review_required': True}

    try:
        img = Image.open(raw_path)
        img.verify()
        img = Image.open(raw_path).convert('RGB')
    except Exception as exc:
        return {'key': key, 'kind': kind, 'technical_status': 'qc_fail', 'issues': [f'corrupted_image:{exc}'], 'manual_review_required': True}

    w, h = img.size
    out_dir.mkdir(parents=True, exist_ok=True)
    webp_path = out_dir / f'{key}.webp'
    meta = {'width': w, 'height': h, 'square_only': (kind == 'backdrop' and abs(w - h) <= 4)}

    if kind in ('character', 'prop'):
        if w < 1024 or h < 1024:
            issues.append(f'low_resolution:{w}x{h}')
        if abs(w - h) > 4:
            issues.append(f'non_square:{w}x{h}')
        bg_rgb, max_dev = key_color_stats(img)
        meta['bg_rgb'] = bg_rgb
        meta['bg_corner_deviation'] = max_dev
        if max_dev > 45:
            issues.append(f'uneven_background_or_gradient:dev={max_dev}')
        cut = remove_bg(img, bg_rgb)
        try:
            out_img, box = fit_square(cut) if kind == 'character' else fit_prop(cut)
        except ValueError as exc:
            return {'key': key, 'kind': kind, 'technical_status': 'qc_fail', 'issues': [str(exc)], 'meta': meta, 'manual_review_required': True}
        meta['bbox'] = list(box)
        # 裁切檢查：主體是否緊貼原圖邊緣（可能被截斷）
        if box[0] <= 2 or box[1] <= 2 or box[2] >= w - 3 or box[3] >= h - 3:
            issues.append(f'subject_touches_frame_edge:{box}')
        out_img.save(webp_path, 'WEBP', quality=86, method=6)
    else:
        if w < 1024:
            issues.append(f'low_width:{w}')
        if meta['square_only']:
            warnings.append('square_only_backdrop_cropped_to_20x9_check_composition')
        out_img, crop_box = fit_backdrop(img)
        meta['crop_box'] = list(crop_box)
        out_img.save(webp_path, 'WEBP', quality=80, method=6)

    # 驗證 WebP 後製產物可正確開啟且體積合理
    webp_bytes = webp_path.stat().st_size
    try:
        with Image.open(webp_path) as check_im:
            meta['webp_size'] = list(check_im.size)
            meta['webp_mode'] = check_im.mode
    except Exception as exc:
        issues.append(f'webp_verify_failed:{exc}')
    size_limit = 600 * 1024 if kind == 'backdrop' else 300 * 1024
    if webp_bytes > size_limit:
        warnings.append(f'webp_large:{webp_bytes}_bytes')

    manual_checks = (
        ['no_life_or_text', 'empty_ground_zone_matches_horizon', 'series_style_match', 'safe_20x9_crop']
        if kind == 'backdrop'
        else ['species_accuracy', 'limb_count_and_anatomy', 'three_quarter_left_facing', 'series_vinyl_style', 'rarity_accessory_no_baked_halo', 'ip_non_resemblance']
    )
    if key.startswith('prehistoric-09') or key == 'bg-prehistoric':
        warnings.append('mosasaur_water_habitat_scene_qa_required')

    return {
        'key': key,
        'kind': kind,
        'technical_status': 'qc_fail' if issues else 'qc_pass',
        'issues': issues,
        'warnings': warnings,
        'manual_review_required': True,
        'manual_checks': manual_checks,
        'raw_sha256': sha256_file(raw_path),
        'webp_path': str(webp_path.resolve().relative_to(ROOT)).replace('\\', '/'),
        'webp_bytes': webp_bytes,
        'meta': meta,
    }


def main():
    if len(sys.argv) < 2:
        print('Usage: python scripts/art-qc.py <key> [--raw path] [--out-dir dir]', file=sys.stderr)
        sys.exit(2)
    key = sys.argv[1]
    raw_path = RAW_DIR / f'{key}.png'
    out_dir = CANDIDATE_OUT
    if '--raw' in sys.argv:
        raw_path = Path(sys.argv[sys.argv.index('--raw') + 1])
    if '--out-dir' in sys.argv:
        out_dir = Path(sys.argv[sys.argv.index('--out-dir') + 1])
    report = inspect_and_process(key, raw_path, out_dir)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if report['technical_status'] == 'qc_pass' else 1)


if __name__ == '__main__':
    main()
