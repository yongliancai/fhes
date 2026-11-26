# FHES v6.2 候選圖自動技術品質檢查、安全 JPG→PNG 轉換與候選 WebP 後製
# 嚴格邊界：不修改 art/approved.json、assets/creatures/ 與 src/data/art-manifest.js；禁止讀寫工作目錄與授權生圖暫存區外之任意檔案。
# 用法：python scripts/art-qc.py <key> [--from-jpg <path>] [--raw <path>] [--out-dir <dir>]
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = (ROOT / 'art' / 'raw').resolve()
CANDIDATE_OUT = (ROOT / 'assets' / 'candidates').resolve()
APPROVED_PATH = (ROOT / 'art' / 'approved.json').resolve()
ANTIGRAVITY_BRAIN_DIR = (Path.home() / '.gemini' / 'antigravity' / 'brain').resolve()
KEY_RE = re.compile(r'^[a-z0-9-]+(?:_(?:adult|young))?$')
SIZE = 512
BG_W = 1920
PAD = 0.04


def is_within(path: Path, base: Path) -> bool:
    try:
        path.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def validate_key(key: str) -> str:
    if not key or not KEY_RE.match(key):
        raise ValueError(f'invalid_key:{key}')
    return key


def resolve_writable_raw(raw_arg: str | None, key: str) -> Path:
    target = (RAW_DIR / f'{key}.png') if raw_arg is None else Path(raw_arg)
    if not target.is_absolute():
        target = (ROOT / target)
    resolved = target.resolve()
    if not is_within(resolved, RAW_DIR):
        raise ValueError('raw_path_outside_art_raw')
    if resolved.suffix.lower() != '.png':
        raise ValueError('raw_path_must_be_png')
    return resolved


def resolve_writable_out_dir(out_arg: str | None) -> Path:
    target = CANDIDATE_OUT if out_arg is None else Path(out_arg)
    if not target.is_absolute():
        target = (ROOT / target)
    resolved = target.resolve()
    if not (is_within(resolved, CANDIDATE_OUT) or is_within(resolved, RAW_DIR)):
        raise ValueError('out_dir_outside_allowed_dirs')
    return resolved


def resolve_readable_jpg(src_arg: str) -> Path:
    candidate = Path(src_arg)
    if not candidate.is_absolute():
        candidate = (ROOT / candidate)
    resolved = candidate.resolve()
    in_root = is_within(resolved, ROOT)
    in_brain = is_within(resolved, ANTIGRAVITY_BRAIN_DIR)
    if not (in_root or in_brain):
        raise ValueError('source_path_outside_allowed_roots')
    if not resolved.exists() or not resolved.is_file():
        raise ValueError('source_file_missing')
    allowed_exts = ('.jpg', '.jpeg') if (in_brain and not in_root) else ('.jpg', '.jpeg', '.png')
    if resolved.suffix.lower() not in allowed_exts:
        raise ValueError(f'unsupported_source_ext:{resolved.suffix.lower()}')
    return resolved


def load_approved_set() -> set[str]:
    if not APPROVED_PATH.exists():
        return set()
    try:
        return set(json.loads(APPROVED_PATH.read_text(encoding='utf-8')).get('approved', []))
    except Exception:
        return set()


def atomic_save_image(img: Image.Image, target: Path, fmt: str, **save_kwargs):
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f'{target.name}.{os.getpid()}.tmp')
    try:
        img.save(tmp, format=fmt, **save_kwargs)
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def convert_jpg_to_png(src_path: Path, dst_png: Path, key: str) -> dict:
    # 保護已人工核准的正式原圖不被誤覆蓋
    default_raw = (RAW_DIR / f'{key}.png').resolve()
    if dst_png == default_raw and key in load_approved_set():
        raise ValueError(f'refuse_overwrite_approved_raw:{key}')
    try:
        with Image.open(src_path) as check_im:
            check_im.verify()
        with Image.open(src_path) as im:
            rgb = im.convert('RGB')
            atomic_save_image(rgb, dst_png, 'PNG')
            return {'converted_from_jpg': True, 'source_size': list(rgb.size)}
    except Exception as exc:
        raise ValueError(f'jpg_conversion_failed:{exc}') from exc


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


def inspect_and_process(key: str, raw_path: Path, out_dir: Path, from_jpg: str | None = None):
    kind = kind_of(key)
    issues = []
    warnings = []
    conversion_meta = {'converted_from_jpg': False}

    if from_jpg is not None:
        src_path = resolve_readable_jpg(from_jpg)
        conversion_meta = convert_jpg_to_png(src_path, raw_path, key)

    if not raw_path.exists():
        return {'key': key, 'kind': kind, 'technical_status': 'qc_fail', 'issues': ['missing_raw_file'], 'manual_review_required': True}

    try:
        with Image.open(raw_path) as check_im:
            check_im.verify()
        with Image.open(raw_path) as opened:
            img = opened.convert('RGB')
    except Exception as exc:
        return {'key': key, 'kind': kind, 'technical_status': 'qc_fail', 'issues': [f'corrupted_image:{exc}'], 'manual_review_required': True}

    w, h = img.size
    out_dir.mkdir(parents=True, exist_ok=True)
    webp_path = out_dir / f'{key}.webp'
    meta = {
        'width': w,
        'height': h,
        'square_only': (kind == 'backdrop' and abs(w - h) <= 4),
        **conversion_meta,
    }

    if kind in ('character', 'prop'):
        if w < 1024 or h < 1024:
            issues.append(f'low_resolution:{w}x{h}')
        if abs(w - h) > 4:
            issues.append(f'non_square:{w}x{h}')
        bg_rgb, max_dev = key_color_stats(img)
        meta['bg_rgb'] = list(bg_rgb)
        meta['bg_corner_deviation'] = max_dev
        if max_dev > 45:
            issues.append(f'uneven_background_or_gradient:dev={max_dev}')
        cut = remove_bg(img, bg_rgb)
        try:
            out_img, box = fit_square(cut) if kind == 'character' else fit_prop(cut)
        except ValueError as exc:
            webp_path.unlink(missing_ok=True)
            return {'key': key, 'kind': kind, 'technical_status': 'qc_fail', 'issues': [str(exc)], 'meta': meta, 'manual_review_required': True}
        meta['bbox'] = list(box)
        if box[0] <= 2 or box[1] <= 2 or box[2] >= w - 3 or box[3] >= h - 3:
            issues.append(f'subject_touches_frame_edge:{list(box)}')
        if not issues:
            atomic_save_image(out_img, webp_path, 'WEBP', quality=86, method=6)
    else:
        if w < 1024:
            issues.append(f'low_width:{w}')
        if h < 512:
            issues.append(f'low_height:{h}')
        if meta['square_only']:
            warnings.append('square_only_backdrop_cropped_to_20x9_check_composition')
        out_img, crop_box = fit_backdrop(img)
        meta['crop_box'] = list(crop_box)
        meta['crop_removed_top_ratio'] = round(crop_box[1] / h, 3) if h else 0
        meta['crop_removed_bottom_ratio'] = round((h - crop_box[3]) / h, 3) if h else 0
        if not issues:
            atomic_save_image(out_img, webp_path, 'WEBP', quality=80, method=6)

    webp_bytes = 0
    rel_webp = None
    if not issues:
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
        rel_webp = str(webp_path.resolve().relative_to(ROOT)).replace('\\', '/')

    if issues:
        webp_path.unlink(missing_ok=True)
        rel_webp = None
        webp_bytes = 0

    manual_checks = (
        ['no_life_or_text', 'empty_ground_zone_matches_horizon', 'series_style_match', 'safe_20x9_crop_composition']
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
        'raw_path': str(raw_path.resolve().relative_to(ROOT)).replace('\\', '/'),
        'raw_sha256': sha256_file(raw_path),
        'webp_path': rel_webp,
        'webp_bytes': webp_bytes,
        'meta': meta,
    }


def parse_flag(args: list[str], flag: str) -> str | None:
    if flag not in args:
        return None
    idx = args.index(flag)
    if idx + 1 >= len(args):
        raise ValueError(f'missing_value_for:{flag}')
    return args[idx + 1]


def main():
    if len(sys.argv) < 2:
        print('Usage: python scripts/art-qc.py <key> [--from-jpg path] [--raw path] [--out-dir dir]', file=sys.stderr)
        sys.exit(2)
    try:
        key = validate_key(sys.argv[1])
        args = sys.argv[2:]
        raw_path = resolve_writable_raw(parse_flag(args, '--raw'), key)
        out_dir = resolve_writable_out_dir(parse_flag(args, '--out-dir'))
        from_jpg = parse_flag(args, '--from-jpg')
        report = inspect_and_process(key, raw_path, out_dir, from_jpg=from_jpg)
    except ValueError as exc:
        print(json.dumps({
            'key': sys.argv[1] if len(sys.argv) > 1 else '',
            'technical_status': 'qc_fail',
            'issues': [str(exc)],
            'manual_review_required': True,
        }, ensure_ascii=False, indent=2))
        sys.exit(2)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if report['technical_status'] == 'qc_pass' else 1)


if __name__ == '__main__':
    main()
