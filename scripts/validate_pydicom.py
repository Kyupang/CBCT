"""Independent cross-check of the phantom files with pydicom (a different DICOM stack).

    python scripts/validate_pydicom.py data/phantom/<set>

- reads every file with strict value validation (bad DS/UI/IS lengths or characters raise)
- sorts by IPP projected on the IOP normal, applies Modality LUT (slope/intercept)
- checks each phantom object's centre against truth.json (nearest voxel)
Requires: pip install pydicom numpy
"""
import json
import sys
from pathlib import Path

import numpy as np
import pydicom
from pydicom.config import RAISE, settings
from pydicom.pixels import apply_modality_lut

settings.reading_validation_mode = RAISE

d = Path(sys.argv[1])
truth = json.loads((d / "truth.json").read_text())
files = sorted(p for p in d.iterdir() if p.suffix == ".dcm")
dss = [pydicom.dcmread(p) for p in files]
for ds in dss:
    for el in ds.iterall():  # force value conversion -> validation
        _ = el.value

iop = np.array(dss[0].ImageOrientationPatient, dtype=float)
row, col = iop[:3], iop[3:]
normal = np.cross(row, col)
dss.sort(key=lambda ds: float(np.dot(np.array(ds.ImagePositionPatient, dtype=float), normal)))
pos = np.array([np.dot(np.array(ds.ImagePositionPatient, dtype=float), normal) for ds in dss])
ps = [float(x) for x in dss[0].PixelSpacing]  # [row spacing, col spacing]
origin = np.array(dss[0].ImagePositionPatient, dtype=float)

hu = np.stack([apply_modality_lut(ds.pixel_array, ds).astype(np.float64) for ds in dss])  # [k, row, col]

ok = True
for o in truth["objects"]:
    c = np.array(o["center"], dtype=float)
    rel = c - origin
    i = rel @ row / ps[1]  # column index
    j = rel @ col / ps[0]  # row index
    zk = rel @ normal
    k = int(np.argmin(np.abs(pos - pos[0] - zk)))  # nearest actual slice
    v = hu[k, int(round(j)), int(round(i))]
    good = v == o["hu"]
    ok &= bool(good)
    print(f"{o['name']:<14} expected {o['hu']:>6}  pydicom {v:>8.1f}  {'OK' if good else 'MISMATCH'}")

print(f"{len(dss)} files, TS {dss[0].file_meta.TransferSyntaxUID.name}, BitsStored {dss[0].BitsStored}, "
      f"PixelRepresentation {dss[0].PixelRepresentation}, slice diffs {np.unique(np.round(np.diff(pos), 4))}")
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
