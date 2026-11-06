"""Parchment texture generator (docs/rendering-performance.md, rule 2).

Each texture is a translucent overlay: brown ink where the paper is darker, cream where it
is lighter, alpha for strength. It sits over a surface's background-color, so one file
serves the canvas, the sidebar and the sheets and the colour tokens stay in index.css.

Noise is synthesised in the frequency domain (FFT), which makes every texture periodic:
a tile repeats seamlessly. Deterministic: same seed, same image.

    python3 -I scripts/parchment/generate.py OUT_DIR [option ...]

Options: vellum, laid, folio, calfskin (default: all). Needs numpy and Pillow with WebP.
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

INK = np.array([104, 64, 18], dtype=np.float64)  # darkening: sepia brown
FOX = np.array([140, 72, 24], dtype=np.float64)  # foxing spots: rust
CREAM = np.array([255, 251, 238], dtype=np.float64)  # lightening


def freqs(h, w):
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    return fx, fy


def norm(a):
    a = a - a.mean()
    return a / (a.std() + 1e-9)


def fbm(rng, h, w, beta, lo=0.0, hi=0.5, sx=1.0, sy=1.0):
    """Periodic 1/f^beta noise between spatial frequencies lo and hi (cycles per px).
    sx/sy stretch the spectrum: sy > sx gives streaks along y."""
    fx, fy = freqs(h, w)
    k = np.sqrt((fx * sx) ** 2 + (fy * sy) ** 2)
    k[0, 0] = 1.0
    amp = k ** (-beta / 2)
    amp[(k < lo) | (k > hi)] = 0
    amp[0, 0] = 0
    f = np.fft.fft2(rng.standard_normal((h, w))) * amp
    return norm(np.real(np.fft.ifft2(f)))


def blur(a, sigma):
    fx, fy = freqs(*a.shape)
    g = np.exp(-2 * (np.pi * sigma) ** 2 * (fx**2 + fy**2))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * g))


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def spots(rng, h, w, count, sigma, jitter=0.5):
    """Soft round spots at random positions (wrapping, so tiles stay seamless)."""
    acc = np.zeros((h, w))
    for s in np.atleast_1d(sigma):
        pts = np.zeros((h, w))
        n = int(count / len(np.atleast_1d(sigma)))
        ys, xs = rng.integers(0, h, n), rng.integers(0, w, n)
        pts[ys, xs] = rng.uniform(1 - jitter, 1 + jitter, n)
        b = blur(pts, s)
        acc += b / (b.max() + 1e-9)
    return np.clip(acc, 0, 1)


def fibres(rng, h, w, density, length, angle_jitter=0.08):
    """Near-vertical short fibres: anisotropic noise, thresholded into thin streaks."""
    n = fbm(rng, h, w, 0.0, lo=0.0, hi=0.5, sx=1.0, sy=length)
    n = blur(n, 0.6)
    n = norm(n)
    return smoothstep(2.4 - density, 3.4 - density, n)


def chain_lines(rng, h, w, spacing):
    """Vertical chain lines of laid paper: wobbly, uneven, faint."""
    x = np.arange(w)[None, :].astype(np.float64)
    y = np.arange(h)[:, None].astype(np.float64)
    count = max(1, round(w / spacing))
    period = w / count
    wobble = 1.2 * np.sin(2 * np.pi * (y / h) * 3 + rng.uniform(0, 6)) + 0.6 * fbm(
        rng, h, 1, 2.0, hi=0.05
    ).reshape(h, 1)
    d = np.abs(((x + wobble) % period) - period / 2)
    line = np.exp(-((d / 0.9) ** 2))
    strength = 0.6 + 0.4 * fbm(rng, h, w, 2.5, hi=0.02)  # fades along its length
    return line * np.clip(strength, 0, 1.5)


def edges(h, w, rng, width):
    """Darker, uneven edges for a full-window sheet."""
    y = np.linspace(0, 1, h)[:, None]
    x = np.linspace(0, 1, w)[None, :]
    d = np.minimum(np.minimum(x, 1 - x) * w / h, np.minimum(y, 1 - y))
    d = d + 0.025 * fbm(rng, h, w, 2.4, hi=0.02)
    return 1 - smoothstep(0, width, d)


def to_rgba(dark, light=None, fox=None):
    """dark/light/fox: alpha maps in 0..1. Composite them into one straight-alpha image."""
    h, w = dark.shape
    light = np.zeros((h, w)) if light is None else light
    fox = np.zeros((h, w)) if fox is None else fox
    # Over-composite: light first, then dark ink, then foxing on top.
    rgb = np.zeros((h, w, 3))
    a = np.zeros((h, w))
    for col, al in ((CREAM, light), (INK, dark), (FOX, fox)):
        al = np.clip(al, 0, 1)[..., None]
        rgb = col * al + rgb * a[..., None] * (1 - al)
        a = al[..., 0] + a * (1 - al[..., 0])
        rgb = np.where(a[..., None] > 0, rgb / np.maximum(a[..., None], 1e-9), 0)
    out = np.dstack([rgb, a * 255])
    return Image.fromarray(np.clip(np.round(out), 0, 255).astype(np.uint8), "RGBA")


def vellum(rng, s=1024):
    mottle = fbm(rng, s, s, 2.6, lo=1 / 700, hi=0.06)
    cloud = fbm(rng, s, s, 1.8, lo=1 / 180, hi=0.2)
    grain = blur(fbm(rng, s, s, 0.0), 0.7)
    grain = norm(grain)
    fib = fibres(rng, s, s, density=0.3, length=14)
    dark = 0.035 + 0.022 * mottle + 0.010 * cloud + 0.008 * grain + 0.05 * fib
    light = np.clip(-0.03 * mottle, 0, None)
    return to_rgba(np.clip(dark, 0, 1), light)


def laid(rng, s=1024):
    mottle = fbm(rng, s, s, 2.6, lo=1 / 700, hi=0.06)
    grain = norm(blur(fbm(rng, s, s, 0.0), 0.7))
    fib = fibres(rng, s, s, density=0.2, length=12)
    chains = chain_lines(rng, s, s, spacing=42)
    dark = 0.03 + 0.02 * mottle + 0.009 * grain + 0.04 * fib + 0.016 * chains
    light = np.clip(-0.025 * mottle, 0, None)
    return to_rgba(np.clip(dark, 0, 1), light)


def calfskin(rng, s=1024):
    blotch = fbm(rng, s, s, 3.0, lo=1 / 900, hi=0.03)
    cloud = fbm(rng, s, s, 2.0, lo=1 / 250, hi=0.15)
    vein_n = fbm(rng, s, s, 2.8, lo=1 / 400, hi=0.05, sx=1.0, sy=0.45)
    veins = blur(np.exp(-((vein_n / 0.05) ** 2)), 1.2)  # ridges along the zero crossings
    follicles = spots(rng, s, s, 900, [0.7, 1.1])
    grain = norm(blur(fbm(rng, s, s, 0.0), 0.8))
    dark = (
        0.04
        + 0.035 * blotch
        + 0.012 * cloud
        + 0.05 * veins
        + 0.10 * follicles
        + 0.009 * grain
    )
    light = np.clip(-0.04 * blotch, 0, None)
    return to_rgba(np.clip(dark, 0, 1), light)


def folio(rng, w=1920, h=1200):
    mottle = fbm(rng, h, w, 2.6, lo=1 / 1200, hi=0.05)
    cloud = fbm(rng, h, w, 1.8, lo=1 / 200, hi=0.2)
    grain = norm(blur(fbm(rng, h, w, 0.0), 0.7))
    fib = fibres(rng, h, w, density=0.3, length=14)
    # Tide-marked water stains: soft blotches with darker rims.
    stain_n = fbm(rng, h, w, 3.2, lo=1 / 1600, hi=0.012)
    stain_n = stain_n + 0.25 * fbm(rng, h, w, 2.2, lo=1 / 300, hi=0.06)  # ragged outline
    stain = smoothstep(1.0, 1.6, stain_n)
    rim = blur(np.exp(-(((stain_n - 1.22) / 0.08) ** 2)), 2.0) * smoothstep(1.0, 1.3, stain_n)
    fox = spots(rng, h, w, 120, [1.5, 3.0, 6.0]) * 0.5
    fox *= np.clip(0.5 + 0.5 * fbm(rng, h, w, 2.0, hi=0.01), 0, 1)
    edge = edges(h, w, rng, width=0.09)
    dark = (
        0.035
        + 0.025 * mottle
        + 0.010 * cloud
        + 0.008 * grain
        + 0.05 * fib
        + 0.035 * stain
        + 0.03 * rim
        + 0.16 * edge
    )
    light = np.clip(-0.035 * mottle, 0, None)
    return to_rgba(np.clip(dark, 0, 1), light, fox)


# Weathering layers. They go over a base tile as separate CSS layers, because a stain in a
# repeating tile would repeat with it. Full-window ones are stretched to the window
# (background-size: 100% 100%) so edges and folds always meet the window's edges; the
# coffee stain is placed at its own size.

COFFEE = np.array([122, 62, 16], dtype=np.float64)
CHAR = np.array([34, 18, 8], dtype=np.float64)
SCORCH = np.array([128, 62, 18], dtype=np.float64)
TIDE = np.array([118, 80, 34], dtype=np.float64)


def compose(layers, shape):
    """Over-composite (colour, alpha map) layers, first one at the bottom."""
    h, w = shape
    rgb = np.zeros((h, w, 3))
    a = np.zeros((h, w))
    for col, al in layers:
        al = np.clip(al, 0, 1)
        na = al + a * (1 - al)
        rgb = (col * al[..., None] + rgb * (a * (1 - al))[..., None]) / np.maximum(na, 1e-9)[
            ..., None
        ]
        a = na
    out = np.dstack([rgb, a * 255])
    return Image.fromarray(np.clip(np.round(out), 0, 255).astype(np.uint8), "RGBA")


def noise1d(rng, n, beta, hi=0.5):
    """Periodic 1D noise (for values around a circle)."""
    f = np.fft.rfftfreq(n)
    f[0] = 1
    amp = f ** (-beta / 2)
    amp[f > hi] = 0
    amp[0] = 0
    x = np.fft.rfft(rng.standard_normal(n)) * amp
    return norm(np.fft.irfft(x, n))


def ring(rng, h, w, cx, cy, radius, arc=None):
    """One cup ring: sharp dark outer rim, softer inward, faint fill, gaps along it."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    dx, dy = x - cx, y - cy
    r = np.hypot(dx, dy)
    th = np.arctan2(dy, dx)
    idx = ((th + np.pi) / (2 * np.pi) * 720).astype(int) % 720
    wob = noise1d(rng, 720, 3.0, hi=0.02)[idx] * radius * 0.025
    wob += noise1d(rng, 720, 1.5, hi=0.1)[idx] * 1.2
    dr = r - (radius + wob)
    rim = np.where(dr < 0, np.exp(-((dr / 5.0) ** 2)), np.exp(-((dr / 1.4) ** 2)))
    inner = 0.45 * np.exp(-(((dr + radius * 0.09) / 2.5) ** 2))  # second, fainter ring
    strength = np.clip(0.55 + 0.45 * noise1d(rng, 720, 2.0, hi=0.03)[idx], 0.05, 1)
    fill = (dr < 0) * (0.35 + 0.25 * fbm(rng, h, w, 2.5, hi=0.03)) * smoothstep(0, 30, -dr)
    a = 0.38 * rim * strength + 0.12 * inner * strength + 0.07 * fill
    if arc is not None:  # keep only part of the ring: (centre angle, half width), radians
        c, half = arc
        dth = np.angle(np.exp(1j * (th - c)))
        a *= 1 - smoothstep(half - 0.35, half, np.abs(dth))
    return a


def coffee(rng, w=600, h=480):
    a = ring(rng, h, w, 330, 270, 150)
    a = np.maximum(a, ring(rng, h, w, 205, 175, 142, arc=(np.pi * 0.85, 1.7)))
    drips = spots(rng, h, w, 7, [2.5, 4.0], jitter=0.4)
    near = np.exp(-((np.hypot(*np.mgrid[0:h, 0:w] - np.array([270, 330])[:, None, None]) - 185) / 40) ** 2)
    a = np.maximum(a, 0.28 * drips * near)
    return compose([(COFFEE, a)], (h, w))


def edge_distance(rng, h, w, soft=45.0):
    """Distance in px to the window edge, rounded into the corners and made ragged."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    ds = np.stack([x, w - 1 - x, y, h - 1 - y])
    d = -soft * np.log(np.exp(-ds / soft).sum(0))
    d += 7 + 10 * fbm(rng, h, w, 3.0, hi=0.006) + 4 * fbm(rng, h, w, 2.2, lo=0.004, hi=0.05)
    d += 1.2 * fbm(rng, h, w, 1.0, lo=0.05, hi=0.3)
    return d


def burnt(rng, w=1920, h=1200):
    d = edge_distance(rng, h, w)
    char = 0.85 * (1 - smoothstep(0, 5, d))
    scorch = 0.42 * np.exp(-np.maximum(d, 0) / 16)
    halo = 0.10 * np.exp(-np.maximum(d, 0) / 110)
    return compose([(INK, halo), (SCORCH, scorch), (CHAR, char)], (h, w))


def water(rng, w=1920, h=1200):
    n = fbm(rng, h, w, 3.3, lo=1 / 1800, hi=0.01)
    n = n + 0.12 * fbm(rng, h, w, 2.6, lo=1 / 400, hi=0.015)  # uneven outlines
    fill = 0.08 * smoothstep(0.85, 1.5, n)
    rims = sum(
        k * np.exp(-(((n - t) / 0.012) ** 2)) for t, k in ((0.9, 0.16), (1.15, 0.11), (1.4, 0.08))
    )
    rims = blur(rims, 1.6) * np.clip(0.6 + 0.4 * fbm(rng, h, w, 2.0, hi=0.02), 0, 1)
    fox = spots(rng, h, w, 140, [1.3, 2.5, 5.0], jitter=0.6)
    clusters = smoothstep(0.3, 1.4, fbm(rng, h, w, 3.0, hi=0.008))  # foxing comes in patches
    return compose([(TIDE, fill + rims), (FOX, 0.55 * fox * (0.15 + 0.85 * clusters))], (h, w))


def fold(rng, w=1920, h=1200):
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    dark = np.zeros((h, w))
    light = np.zeros((h, w))
    for pos, along, size in ((x, y, w), (y, x, h)):
        wob = 3 * np.sin(along / 260 + rng.uniform(0, 6)) + 1.5 * np.sin(along / 71 + rng.uniform(0, 6))
        dd = pos - (size / 2 + wob)
        crease = np.exp(-((dd / 1.1) ** 2))
        shadow = np.exp(-(np.maximum(-dd, 0) / 22)) * (dd < 0)
        highlight = np.exp(-(((dd - 2.5) / 2.2) ** 2))
        fade = np.clip(0.75 + 0.25 * fbm(rng, h, w, 2.5, hi=0.01), 0, 1)
        dark += (0.22 * crease + 0.07 * shadow) * fade
        light += 0.40 * highlight * fade
        # Grime that collects along the fold.
        dark += 0.09 * np.exp(-np.abs(dd) / 40) * np.clip(fbm(rng, h, w, 2.2, hi=0.04), 0, None)
    # Rubbed, grubby corners.
    corner = np.exp(-np.minimum.reduce([np.hypot(x - cx, y - cy) for cx in (0, w) for cy in (0, h)]) / 260)
    dark += 0.14 * corner * np.clip(0.6 + 0.5 * fbm(rng, h, w, 2.0, hi=0.03), 0, 1.4)
    return compose([(CREAM, light), (INK, dark)], (h, w))


OPTIONS = {
    "vellum": vellum,
    "laid": laid,
    "calfskin": calfskin,
    "folio": folio,
    "coffee": coffee,
    "burnt": burnt,
    "water": water,
    "fold": fold,
}

TILES = {"vellum", "laid", "calfskin", "folio"}


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    names = sys.argv[2:] or list(OPTIONS)
    for i, name in enumerate(names):
        img = OPTIONS[name](np.random.default_rng(1000 + list(OPTIONS).index(name)))
        path = out / f"parchment-{name}.webp"
        aq = 60 if name in TILES else 100  # quantised alpha bands smooth weathering
        img.save(path, "WEBP", quality=72, alpha_quality=aq, method=6)
        print(f"{path} {img.size[0]}x{img.size[1]} {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
