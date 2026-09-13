from PIL import Image
import math
import os

ROOT = os.path.join(os.path.dirname(__file__), "..")
SRC = os.path.join(
    ROOT,
    "assets",
    "icon-candidates",
    "volume-master-icon-04-glass-modern.png",
)
OUT_DIR = os.path.join(ROOT, "assets", "icon-candidates")
ICONS_DIR = os.path.join(ROOT, "icons")


def luminance(r, g, b):
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def is_outer_dark(r, g, b):
    """Dark navy corners outside the glass circle."""
    return luminance(r, g, b) < 55 and max(r, g, b) < 70


def process_icon(src_path, out_path):
    im = Image.open(src_path).convert("RGBA")
    w, h = im.size
    cx, cy = (w - 1) / 2, (h - 1) / 2
    radius = min(w, h) * 0.465
    pixels = im.load()
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out_px = out.load()

    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if a < 8:
                continue

            dist = math.hypot(x - cx, y - cy)

            # Only strip the dark square corners; keep the full colored glass circle.
            if dist > radius and is_outer_dark(r, g, b):
                continue

            # Soft edge on the outer rim so the circle doesn't look clipped.
            if dist > radius * 0.94:
                edge = (dist - radius * 0.94) / (radius * 0.06)
                alpha = int(255 * (1.0 - min(1.0, max(0.0, edge))))
                if alpha < 4:
                    continue
                out_px[x, y] = (r, g, b, alpha)
                continue

            out_px[x, y] = (r, g, b, 255)

    out.save(out_path, optimize=True)
    return out


def export_sizes(icon, icons_dir):
    os.makedirs(icons_dir, exist_ok=True)
    for size in (16, 48, 128, 256):
        icon.resize((size, size), Image.Resampling.LANCZOS).save(
            os.path.join(icons_dir, f"icon{size}.png"),
            optimize=True,
        )


if __name__ == "__main__":
    processed = process_icon(
        SRC,
        os.path.join(OUT_DIR, "volume-master-icon-04-glass-modern-transparent.png"),
    )
    export_sizes(processed, ICONS_DIR)
    print("Saved transparent candidate and extension icons")
