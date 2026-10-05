"""Вырезание фона из 3D-рендеров под сплэш-экран P2P Light."""
import os
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

SRC = os.environ.get('SRC', 'assets/_raw')          # исходные рендеры (1.jpg, 2.jpg, 3.jpg)
OUT = os.environ.get('OUT', 'assets/splash')        # сюда кладутся вырезанные PNG
os.makedirs(OUT, exist_ok=True)


def disk(r):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return x * x + y * y <= r * r


def fit_background(rgb, border=70, degree=3):
    """Студийный градиент хорошо описывается полиномом; считаем его по рамке."""
    h, w = rgb.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    yn, xn = yy / h, xx / w

    terms = [np.ones_like(xn)]
    for d in range(1, degree + 1):
        for k in range(d + 1):
            terms.append((xn ** (d - k)) * (yn ** k))
    A_full = np.stack([t.ravel() for t in terms], axis=1)

    ring = np.zeros((h, w), bool)
    ring[:border] = ring[-border:] = True
    ring[:, :border] = ring[:, -border:] = True
    idx = ring.ravel()

    model = np.empty_like(rgb, dtype=np.float32)
    for c in range(3):
        coef, *_ = np.linalg.lstsq(A_full[idx], rgb[:, :, c].ravel()[idx].astype(np.float32), rcond=None)
        model[:, :, c] = (A_full @ coef).reshape(h, w)
    return model



def min_area_rect(mask):
    """Минимальный повёрнутый прямоугольник вокруг маски (вращающиеся штангенциркули)."""
    from scipy.spatial import ConvexHull
    ys, xs = np.nonzero(mask)
    pts = np.stack([xs, ys], axis=1).astype(np.float64)
    hull = pts[ConvexHull(pts).vertices]
    best = None
    for i in range(len(hull)):
        e = hull[(i + 1) % len(hull)] - hull[i]
        n = np.hypot(*e)
        if n < 1e-9:
            continue
        c, s_ = e / n
        rot = np.array([[c, s_], [-s_, c]])
        q = hull @ rot.T
        lo, hi = q.min(axis=0), q.max(axis=0)
        area = np.prod(hi - lo)
        if best is None or area < best[0]:
            best = (area, rot, lo, hi)
    _, rot, lo, hi = best
    corners = np.array([[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]]) @ rot
    return corners


def fill_quad(shape, corners, grow=0.0):
    """Растеризация выпуклого четырёхугольника, расширенного наружу на `grow`."""
    c = corners.mean(axis=0)
    if grow:
        v = corners - c
        corners = c + v * (1 + grow / np.linalg.norm(v, axis=1, keepdims=True))
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    inside = np.ones((h, w), bool)
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        ex, ey = b - a
        side = (xx - a[0]) * ey - (yy - a[1]) * ex
        inside &= (side <= 0) if np.sign(((c - a)[0] * ey - (c - a)[1] * ex)) < 0 else (side >= 0)
    return inside



def card_quad_from_edges(mask, long_deg=None):
    """
    Силуэт карты по её собственным рёбрам.

    Хаф уверенно находит два длинных ребра и одно короткое; четвёртое ребро
    берём как максимум проекции маски на ту же нормаль, но считаем проекцию
    ТОЛЬКО внутри полосы между длинными рёбрами — так ореол свечения,
    который лежит выше верхней кромки, в расчёт не попадает.
    """
    from skimage.feature import canny
    from skimage.transform import hough_line, hough_line_peaks

    ys, xs = np.nonzero(mask)
    roi = np.zeros_like(mask)
    roi[ys.min():ys.max() + 1, xs.min():xs.max() + 1] = True

    edges = canny(GRAY / 255., sigma=2.4, low_threshold=.04, high_threshold=.12) & roi
    hh, th, dd = hough_line(edges, theta=np.linspace(-np.pi / 2, np.pi / 2, 1440))
    peaks = list(zip(*hough_line_peaks(hh, th, dd, num_peaks=14, threshold=0.25 * hh.max())))
    if not peaks:
        raise SystemExit('рёбра карты не найдены')

    base = peaks[0][1]                                   # самое сильное ребро задаёт ориентацию
    para = sorted(r for _, a, r in peaks if abs(np.sin(a - base)) < 0.12)
    perp = [(a, r) for _, a, r in peaks if abs(np.cos(a - base)) < 0.3]
    if len(para) < 2 or not perp:
        raise SystemExit('не хватает рёбер карты')
    lo, hi = para[0], para[-1]

    yy, xx = np.nonzero(mask)
    band = (xx * np.cos(base) + yy * np.sin(base))
    inside = (band > lo + 6) & (band < hi - 6)           # полоса самой карты
    a2 = perp[0][0]
    proj = xx[inside] * np.cos(a2) + yy[inside] * np.sin(a2)
    short = sorted([perp[0][1], proj.min() if abs(proj.max() - perp[0][1]) < abs(proj.min() - perp[0][1]) else proj.max()])

    def meet(t1, r1, t2, r2):
        A = np.array([[np.cos(t1), np.sin(t1)], [np.cos(t2), np.sin(t2)]])
        return np.linalg.solve(A, [r1, r2])

    return np.array([meet(base, lo, a2, short[0]), meet(base, lo, a2, short[1]),
                     meet(base, hi, a2, short[1]), meet(base, hi, a2, short[0])])


def largest(mask, keep=1, min_frac=0.002):
    lbl, n = ndimage.label(mask)
    if n == 0:
        return mask
    sizes = ndimage.sum(mask, lbl, range(1, n + 1))
    out = np.zeros_like(mask)
    for i in np.argsort(sizes)[::-1][:keep]:
        if sizes[i] / mask.size < min_frac:
            break
        out |= (lbl == i + 1)
    return out


def save(rgb, fg, name, feather=1.6, pad=12, bleed=2):
    """Мягкая альфа + усадка края внутрь, чтобы не тянуть ореол фона."""
    fg = ndimage.binary_fill_holes(fg)
    if bleed:
        fg = ndimage.binary_erosion(fg, disk(bleed))
    a = Image.fromarray((fg * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(feather))
    alpha = np.clip((np.asarray(a).astype(np.float32) - 70) * (255 / 130), 0, 255).astype(np.uint8)

    img = Image.fromarray(np.dstack([rgb.astype(np.uint8), alpha]), 'RGBA')
    ys, xs = np.where(alpha > 10)
    img = img.crop((max(0, xs.min() - pad), max(0, ys.min() - pad),
                    min(img.width, xs.max() + pad), min(img.height, ys.max() + pad)))
    img.save(f'{OUT}/{name}.png')
    print(f'  {name}: {img.width}x{img.height}')
    return img


# ============ 1. белая карта: остаток после вычитания градиента ============
print('1.jpg — белая карта')
rgb1 = np.asarray(Image.open(f'{SRC}/1.jpg').convert('RGB')).astype(np.float32)
resid = np.abs(rgb1 - fit_background(rgb1)).max(axis=2)
mask = resid > 16
mask = ndimage.binary_closing(mask, disk(4))
# к верхней кромке липнет ореол свечения кольца, поэтому силуэт берём
# не из маски, а из прямых рёбер самой карты
GRAY = rgb1.mean(axis=2)
core = largest(ndimage.binary_opening(mask, disk(12)), keep=1)
card = fill_quad(mask.shape, card_quad_from_edges(core), grow=3)
card = ndimage.binary_opening(card, disk(26))      # скруглить углы как у настоящей карты
save(rgb1, card, 'card-white', bleed=1)

# ============ 2. тёмные карты: нейтральные пиксели против коричневых ============
print('2.jpg — пара карт')
rgb2 = np.asarray(Image.open(f'{SRC}/2.jpg').convert('RGB')).astype(np.float32)
r, g, b = rgb2[:, :, 0], rgb2[:, :, 1], rgb2[:, :, 2]
brown = (r >= g - 4) & (g >= b - 4) & (r - b > 14)   # фон и запечённая тень
fg2 = ~brown
fg2 = ndimage.binary_opening(fg2, disk(3))
fg2 = largest(fg2, keep=1)
fg2 = ndimage.binary_closing(fg2, disk(6))
save(rgb2, fg2, 'cards-dark')

# ============ 3. кошелёк: снять шахматку ============
print('3.jpg — кошелёк')
rgb3 = np.asarray(Image.open(f'{SRC}/3.jpg').convert('RGB')).astype(np.float32)
light = (rgb3.min(axis=2) > 196) & (rgb3.max(axis=2) - rgb3.min(axis=2) < 16)
lbl, _ = ndimage.label(light)
edge_ids = set(np.unique(np.concatenate([lbl[0], lbl[-1], lbl[:, 0], lbl[:, -1]]))) - {0}
checker = ndimage.binary_closing(np.isin(lbl, list(edge_ids)), disk(4))
fg3 = largest(~checker, keep=1)
save(rgb3, fg3, 'wallet', bleed=1)
