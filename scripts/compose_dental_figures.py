"""Compose the PNG figures of docs/DENTAL-LOG.md.

Inputs: a ToothFairy case folder (DICOM) and the raw folder written by
scripts/dental-figures.ts + scripts/screens-dental.mjs. Patient-identifying header fields are
masked: the export still carries birth date, sex, ID and study date (see DENTAL-LOG #D6).

Usage:
  pip install pydicom numpy pillow
  python scripts/compose_dental_figures.py <case_dir> <raw_dir> <out_dir>
"""
import json
import pathlib
import sys

import numpy as np
import pydicom
from PIL import Image, ImageDraw, ImageFont

case, raw, out = (pathlib.Path(a) for a in sys.argv[1:4])
out.mkdir(parents=True, exist_ok=True)
FONT = "C:/Windows/Fonts/malgun.ttf"
MONO = "C:/Windows/Fonts/consola.ttf"
BG = (24, 27, 31)
FG = (230, 232, 235)
MUTED = (150, 156, 165)
ACCENT = (171, 202, 14)


def font(size, mono=False):
    try:
        return ImageFont.truetype(MONO if mono else FONT, size)
    except OSError:
        return ImageFont.load_default()


def win(a, c=1000, w=4000):
    return (np.clip((a - (c - w / 2)) / w, 0, 1) * 255).astype(np.uint8)


def fit(img: Image.Image, w: int, h: int) -> Image.Image:
    s = min(w / img.width, h / img.height)
    return img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))), Image.LANCZOS)


def panel_row(items, h, title, path, gap=24, pad=28, top=64, label_h=58):
    """items: [(PIL image, label, sublabel)] placed left to right, each scaled to height h."""
    tiles = [fit(im.convert("RGB"), 10_000, h) for im, _, _ in items]
    w = sum(t.width for t in tiles) + gap * (len(tiles) - 1) + 2 * pad
    canvas = Image.new("RGB", (w, top + h + label_h + pad), BG)
    d = ImageDraw.Draw(canvas)
    d.text((pad, 18), title, fill=FG, font=font(22))
    x = pad
    for t, (_, label, sub) in zip(tiles, items):
        canvas.paste(t, (x, top))
        d.text((x, top + h + 10), label, fill=FG, font=font(16))
        if sub:
            d.text((x, top + h + 32), sub, fill=MUTED, font=font(13))
        x += t.width + gap
    canvas.save(path)
    print("saved", path)


# --- 02: what one scanner export folder contains ---------------------------------------
series = {}
for f in sorted(case.iterdir()):
    try:
        ds = pydicom.dcmread(f)
    except Exception:
        continue
    if "SeriesNumber" not in ds or "PixelData" not in ds:
        continue
    key = (str(ds.SeriesNumber), ds.SOPClassUID.name)
    series.setdefault(key, []).append(ds)
for v in series.values():
    v.sort(key=lambda x: int(x.get("InstanceNumber", 0) or 0))


def img_of(ds, window=True):
    a = ds.pixel_array.astype(np.float32) * float(ds.get("RescaleSlope", 1)) + float(ds.get("RescaleIntercept", 0))
    return Image.fromarray(win(a) if window else a.astype(np.uint8))


def tile(im: Image.Image, w: int, h: int) -> Image.Image:
    """Fit into a fixed w x h box so that labels under each tile have the same width."""
    box = Image.new("RGB", (w, h), (0, 0, 0))
    t = fit(im.convert("RGB"), w, h)
    box.paste(t, ((w - t.width) // 2, (h - t.height) // 2))
    return box


def first(pred):
    return next(lst for (sn, cls), lst in sorted(series.items(), key=lambda kv: int(kv[0][0])) if pred(sn, cls, lst[0]))


loc = first(lambda sn, cls, d: "LOCALIZER" in d.ImageType)
axl = first(lambda sn, cls, d: "AXIAL" in d.ImageType)
pano_series = [lst for (sn, cls), lst in series.items() if cls.startswith("CT") and lst[0].Columns > 500]
cs_series = first(lambda sn, cls, d: cls.startswith("CT") and "REFORMATTED" in d.ImageType and d.Columns < 150)
sc = first(lambda sn, cls, d: cls.startswith("Secondary") and sn == str(cs_series[0].SeriesNumber))
def tooth_pixels(x):
    a = np.asarray(x.pixel_array)
    hu = a.astype(np.float32) * float(x.RescaleSlope) + float(x.RescaleIntercept)
    return int(((hu > 2000) & (a != 65535)).sum())


pano_best = max((x for lst in pano_series for x in lst), key=tooth_pixels)
TW, TH = 300, 300
items = [
    (tile(img_of(loc[0]), TW, TH), "위치 확인용 사진", f"{len(loc)}장 · ORIGINAL · LOCALIZER"),
    (tile(img_of(axl[len(axl) // 2]), TW, TH), "원본 축상 영상 ← 볼륨", f"{len(axl)}장 · ORIGINAL · AXIAL"),
    (tile(img_of(pano_best), TW, TH), "장비 SW 파노라마", f"{len(pano_series)}세트 × {len(pano_series[0])}층 · REFORMATTED"),
    (tile(img_of(cs_series[len(cs_series) // 2]), TW, TH), "장비 SW 단면", f"{len(cs_series)}장 · REFORMATTED"),
    (tile(img_of(sc[0]), TW, TH), "화면 캡처 (단면 위치선)", f"{sum(1 for k in series if k[1].startswith('Secondary'))}장 · Secondary Capture"),
]
panel_row(items, TH, "한 환자 폴더(330파일)에 들어 있던 것 — NewTom VGi 내보내기 (ToothFairy P221)", out / "02-folder-contents.png", gap=18)

# --- 03: stacking by InstanceNumber + SliceThickness vs by position -----------------------
a = Image.open(raw / "raw-sagittal-naive.png")
b = Image.open(raw / "raw-sagittal-position.png")
panel_row(
    [(a, "InstanceNumber 순서로 쌓기 (흔한 실수)", "위아래가 뒤집혔는데 화면 라벨은 여전히 S가 위"), (b, "IPP · 법선으로 정렬 (이 뷰어)", "상악동이 위, 하악이 아래")],
    380,
    "같은 파일, 정렬 기준만 다름 — 그럴듯해 보여서 더 위험하다",
    out / "03-naive-vs-position.png",
)

# --- 04: vendor cross-section vs our resampling ------------------------------------------
nums = json.loads((raw / "numbers.json").read_text())
cs = nums["crossSection"]
v = Image.open(raw / "cs-vendor.pgm")
h0 = Image.open(raw / "cs-ours-header.pgm")
h1 = Image.open(raw / "cs-ours-shifted.pgm")
off = cs["offset"]
panel_row(
    [
        (v, "장비 SW가 만든 단면", f"#{cs['instance']} (왼쪽 위 번호는 픽셀에 새겨짐)"),
        (h0, "헤더 좌표 그대로 잘라 봄", f"상관계수 r = {cs['rHeader']:.2f}"),
        (h1, f"({off[0]}, {off[1]}, {off[2]}) mm 옮겨 자름", f"상관계수 r = {cs['rShifted']:.3f}"),
    ],
    430,
    "장비 단면의 위치 정보가 원본 볼륨과 6.8 mm 어긋남 (55장 모두 같은 벡터)",
    out / "04-vendor-offset.png",
)

# --- 05: panorama, vendor vs ours ---------------------------------------------------------
pv = Image.open(raw / "pano-vendor.pgm")
po = Image.open(raw / "pano-ours.pgm")
pn = nums["panorama"]
panel_row(
    [(pv, "장비 SW 파노라마 (치아를 지나는 층, 51층 중 1)", f"{pn['vendorWidth']}px · {pn['vendorMm']:.0f} mm"), (po, "이 뷰어: 자동 치열궁 + 두께 8 mm 평균", f"{pn['oursWidth']}px · {pn['oursMm']:.0f} mm · 기울어진 사랑니 위치 일치")],
    240,
    "파노라마 — 치열궁을 따라 볼륨을 펼친 영상",
    out / "05-pano-compare.png",
)

# --- 06: header, identifying fields masked -------------------------------------------------
ax = series[("11", "CT Image Storage")][83]
MASK = {"PatientName", "PatientID", "PatientBirthDate", "PatientSex", "StudyDate", "AccessionNumber", "OtherPatientIDs"}
rows = [
    ("Manufacturer / Model", f"{ax.Manufacturer} / {ax.ManufacturerModelName}"),
    ("SoftwareVersions", str(ax.SoftwareVersions)),
    ("TransferSyntax", ax.file_meta.TransferSyntaxUID.name),
    ("ImageType", "\\".join(ax.ImageType)),
    ("PatientName", None), ("PatientID", None), ("PatientBirthDate", None), ("PatientSex", None), ("StudyDate", None),  # fmt: skip
    ("Rows × Columns", f"{ax.Rows} × {ax.Columns}"),
    ("PixelSpacing", f"{list(map(float, ax.PixelSpacing))} mm"),
    ("SliceThickness", f"{ax.SliceThickness} mm"),
    ("ImagePositionPatient", str([float(x) for x in ax.ImagePositionPatient])),
    ("ImageOrientationPatient", str([round(float(x), 4) for x in ax.ImageOrientationPatient])),
    ("PatientPosition", str(ax.PatientPosition)),
    ("Bits Stored / Repr.", f"{ax.BitsStored} / {'unsigned' if ax.PixelRepresentation == 0 else 'signed'}"),
    ("Rescale slope / intercept", f"{ax.RescaleSlope} / {ax.RescaleIntercept}"),
    ("Window C / W", f"{ax.WindowCenter} / {ax.WindowWidth}"),
]
W, LH = 1100, 34
img = Image.new("RGB", (W, 90 + LH * len(rows) + 50), BG)
d = ImageDraw.Draw(img)
d.text((28, 22), "원본 축상 영상 1장의 헤더 (pydicom) — 환자 식별 항목은 가림", fill=FG, font=font(22))
y = 72
for k, val in rows:
    d.text((28, y), k, fill=MUTED, font=font(17, mono=True))
    if val is None:
        d.rectangle((360, y + 2, 360 + 260, y + 24), fill=(70, 74, 80))
        d.text((372, y + 2), "가림 (값이 남아 있음)", fill=(200, 120, 120), font=font(15))
    else:
        d.text((360, y), val, fill=FG, font=font(17, mono=True))
    y += LH
d.text((28, y + 12), "익명화된 공개 데이터셋인데도 생년월일·성별·환자 ID·검사일이 남아 있었다.", fill=ACCENT, font=font(16))
img.save(out / "06-header-masked.png")
print("saved", out / "06-header-masked.png")
