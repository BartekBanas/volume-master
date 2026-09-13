from PIL import Image
import os

ROOT = os.path.join(os.path.dirname(__file__), "..")
SRC = os.path.join(ROOT, "assets", "volume-master-icon-candidates.png")
OUT_DIR = os.path.join(ROOT, "assets", "icon-candidates")

NAMES = [
    "01-crown-master",
    "02-power-boost",
    "03-friendly-character",
    "04-glass-modern",
]

im = Image.open(SRC).convert("RGBA")
w, h = im.size
half_w, half_h = w // 2, h // 2

quadrants = [
    (0, 0, half_w, half_h),
    (half_w, 0, w, half_h),
    (0, half_h, half_w, h),
    (half_w, half_h, w, h),
]

os.makedirs(OUT_DIR, exist_ok=True)

for name, box in zip(NAMES, quadrants):
    cell = im.crop(box)
    pixels = cell.load()
    bg = pixels[10, 10][:3]
    threshold = 28

    xs, ys = [], []
    for y in range(cell.height):
        for x in range(cell.width):
            r, g, b, a = pixels[x, y]
            if a < 10:
                continue
            if max(abs(r - bg[0]), abs(g - bg[1]), abs(b - bg[2])) > threshold:
                xs.append(x)
                ys.append(y)

    if xs and ys:
        pad = 12
        left = max(0, min(xs) - pad)
        top = max(0, min(ys) - pad)
        right = min(cell.width, max(xs) + pad + 1)
        bottom = min(cell.height, max(ys) + pad + 1)
        icon = cell.crop((left, top, right, bottom))
    else:
        icon = cell

    iw, ih = icon.size
    side = max(iw, ih)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(icon, ((side - iw) // 2, (side - ih) // 2))

    out_path = os.path.join(OUT_DIR, f"volume-master-icon-{name}.png")
    square.resize((512, 512), Image.Resampling.LANCZOS).save(out_path, optimize=True)
    print(f"Saved {out_path} ({square.size[0]}px -> 512px)")

print(f"Split {SRC} into {len(NAMES)} icons")
