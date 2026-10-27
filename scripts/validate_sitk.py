"""Independent cross-check with ITK (SimpleITK + GDCM), the DICOM stack reader that 3D Slicer
is built on.

Reads the acquired series of a folder with ITK, picks random voxels, and writes their LPS
position and value to <out.json>. tests/external.test.ts then asks the web loader for the
value at each of those LPS points: same position + same value = the two implementations
agree on geometry (origin, axes, spacing, slice order) and on the Modality LUT.

ITK works in LPS like DICOM. 3D Slicer's GUI shows RAS, i.e. x and y negated.

Usage:
  pip install SimpleITK numpy
  python scripts/validate_sitk.py <dicom_dir> <out.json> [--series <SeriesInstanceUID>]
"""
import argparse
import json

import numpy as np
import SimpleITK as sitk


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dicom_dir")
    ap.add_argument("out_json")
    ap.add_argument("--series")
    ap.add_argument("--points", type=int, default=400)
    args = ap.parse_args()

    reader = sitk.ImageSeriesReader()
    ids = reader.GetGDCMSeriesIDs(args.dicom_dir)
    def image_type(s: str) -> str:
        r = sitk.ImageFileReader()
        r.SetFileName(reader.GetGDCMSeriesFileNames(args.dicom_dir, s)[0])
        r.ReadImageInformation()
        return r.GetMetaData("0008|0008") if r.HasMetaDataKey("0008|0008") else ""

    # Same rule as the web loader: the ORIGINAL non-localizer series, then the largest
    def rank(s: str):
        t = image_type(s).upper()
        return ("ORIGINAL" in t and "LOCALIZER" not in t, len(reader.GetGDCMSeriesFileNames(args.dicom_dir, s)))

    series = args.series or max(ids, key=rank)
    files = reader.GetGDCMSeriesFileNames(args.dicom_dir, series)
    reader.SetFileNames(files)
    img = reader.Execute()
    arr = sitk.GetArrayViewFromImage(img)  # [k, j, i]

    rng = np.random.default_rng(7)
    nx, ny, nz = img.GetSize()
    pts = []
    for _ in range(args.points):
        i, j, k = int(rng.integers(0, nx)), int(rng.integers(0, ny)), int(rng.integers(0, nz))
        lps = img.TransformIndexToPhysicalPoint((i, j, k))
        pts.append({"ijk": [i, j, k], "lps": list(lps), "value": float(arr[k, j, i])})

    out = {
        "reader": f"SimpleITK {sitk.Version_VersionString()} (GDCM)",
        "series": series,
        "files": len(files),
        "size": [nx, ny, nz],
        "spacing": list(img.GetSpacing()),
        "origin": list(img.GetOrigin()),
        "direction": list(img.GetDirection()),
        "points": pts,
    }
    with open(args.out_json, "w") as f:
        json.dump(out, f, indent=1)
    print(f"{out['reader']}: {len(files)} files, size {out['size']}, spacing {np.round(out['spacing'], 5)}")
    print(f"  origin {np.round(out['origin'], 3)}  direction {np.round(out['direction'], 4)}")
    print(f"  wrote {len(pts)} points -> {args.out_json}")


if __name__ == "__main__":
    main()
