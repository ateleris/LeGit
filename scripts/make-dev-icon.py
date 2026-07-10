# Regenerates src-tauri/icons/icon-dev.png (the debug-build window/taskbar
# icon) from icon.png: the base logo plus an orange DEV corner ribbon that
# mirrors the in-app DevRibbon (#e08807, near-black text). Re-run whenever
# the logo changes. Needs Pillow and a bold TTF (uses Windows Arial Bold
# via the WSL mount). Run from the repo root.
from PIL import Image, ImageDraw, ImageFont

base = Image.open("src-tauri/icons/icon.png").convert("RGBA")
W, H = base.size  # 512x512

overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(overlay)

# Diagonal ribbon across the bottom-right corner: the band between
# x+y = K1 and x+y = K2 (image coords, y down), clipped to the square.
# Colors mirror the in-app DevRibbon (#e08807 on near-black text).
K1, K2 = W + H - 400, W + H - 110
band = [(K1 - H, H), (W, K1 - W), (W, K2 - W), (K2 - H, H)]
d.polygon(band, fill=(224, 136, 7, 255))
d.line([(K1 - H, H), (W, K1 - W)], fill=(150, 88, 0, 255), width=6)
d.line([(K2 - H, H), (W, K2 - W)], fill=(150, 88, 0, 255), width=6)

# "DEV" along the band (45 deg, reading bottom-left to top-right).
font = ImageFont.truetype("/mnt/c/Windows/Fonts/arialbd.ttf", 128)
tb = ImageDraw.Draw(Image.new("RGBA", (1, 1))).textbbox((0, 0), "DEV", font=font)
tw, th = tb[2] - tb[0], tb[3] - tb[1]
txt = Image.new("RGBA", (tw + 20, th + 20), (0, 0, 0, 0))
ImageDraw.Draw(txt).text((10 - tb[0], 10 - tb[1]), "DEV", font=font, fill=(26, 26, 26, 255))
txt = txt.rotate(45, expand=True, resample=Image.BICUBIC)
# centroid of the band polygon
cx = sum(p[0] for p in band) // 4
cy = sum(p[1] for p in band) // 4
overlay.alpha_composite(txt, (cx - txt.width // 2, cy - txt.height // 2))

out = Image.alpha_composite(base, overlay)
out.save("src-tauri/icons/icon-dev.png")
print("saved", out.size)
