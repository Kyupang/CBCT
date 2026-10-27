"""Convert a NIfTI CBCT volume into a DICOM CT series (one file per slice).

Public dental CBCT sets ship as NIfTI, but scanners and the viewer speak DICOM, so this
turns one into the other.

The trap is the coordinate system. A NIfTI affine maps voxel indices to RAS mm, while
DICOM IPP/IOP are LPS mm, so x and y have to be negated (diag(-1, -1, 1)).

Each output file holds slice k as a 2D image with rows = j and columns = i:
  rowDir (IOP[0:3]) = LPS direction of +i
  colDir (IOP[3:6]) = LPS direction of +j
  IPP              = LPS position of voxel (0, 0, k)
  PixelSpacing     = [|di along j|, |di along i|]

Usage:
  pip install nibabel pydicom numpy
  python scripts/nifti_to_dicom.py <in.nii.gz> <out_dir> [--mask <mask.nii.gz>]

With --mask, the label volume's bounding box and label count are written to
<out_dir>/../<name>.labels.json for the tests to read. The mask is not converted.
"""
import argparse
import json
import pathlib

import nibabel as nib
import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

RAS_TO_LPS = np.diag([-1.0, -1.0, 1.0])


def ds_str(v: float) -> str:
    # DS is at most 16 characters
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    return s if s != "-0" else "0"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("nifti")
    ap.add_argument("out_dir")
    ap.add_argument("--mask")
    ap.add_argument("--description", default="CBCT (converted from NIfTI)")
    args = ap.parse_args()

    img = nib.load(args.nifti)
    data = np.asanyarray(img.dataobj)
    if data.ndim != 3:
        raise SystemExit(f"expected a 3D volume, got shape {data.shape}")
    slope = img.header["scl_slope"]
    inter = img.header["scl_inter"]
    slope = 1.0 if not np.isfinite(slope) or slope == 0 else float(slope)
    inter = 0.0 if not np.isfinite(inter) else float(inter)
    if data.dtype != np.int16:
        if data.min() < -32768 or data.max() > 32767:
            raise SystemExit(f"values {data.min()}..{data.max()} do not fit int16")
        data = np.rint(data).astype(np.int16)

    aff = img.affine
    m = RAS_TO_LPS @ aff[:3, :3]  # columns: LPS mm per +i, +j, +k
    t = RAS_TO_LPS @ aff[:3, 3]
    di, dj, dk = (np.linalg.norm(m[:, c]) for c in range(3))
    row_dir, col_dir = m[:, 0] / di, m[:, 1] / dj
    k_dir = m[:, 2] / dk
    if abs(row_dir @ col_dir) > 1e-4 or abs(k_dir @ row_dir) > 1e-4 or abs(k_dir @ col_dir) > 1e-4:
        raise SystemExit("affine is sheared; a DICOM slice stack cannot represent it")

    nx, ny, nz = data.shape
    out = pathlib.Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    study_uid, series_uid, for_uid = generate_uid(), generate_uid(), generate_uid()

    for k in range(nz):
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CTImageStorage
        meta.MediaStorageSOPInstanceUID = generate_uid()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian

        ds = Dataset()
        ds.file_meta = meta
        ds.SOPClassUID = CTImageStorage
        ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
        ds.StudyInstanceUID = study_uid
        ds.SeriesInstanceUID = series_uid
        ds.FrameOfReferenceUID = for_uid
        ds.Modality = "CT"
        ds.PatientName = "Anonymous^CBCT"
        ds.PatientID = "STS3D"
        ds.SeriesDescription = args.description
        ds.SeriesNumber = 1
        ds.InstanceNumber = k + 1
        ds.ImagePositionPatient = [ds_str(v) for v in (t + k * m[:, 2])]
        ds.ImageOrientationPatient = [ds_str(v) for v in (*row_dir, *col_dir)]
        ds.PixelSpacing = [ds_str(dj), ds_str(di)]
        ds.SliceThickness = ds_str(dk)
        ds.Rows, ds.Columns = ny, nx
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 1
        ds.RescaleSlope = ds_str(slope)
        ds.RescaleIntercept = ds_str(inter)
        ds.WindowCenter = "1000"
        ds.WindowWidth = "4000"
        # data[i, j, k] -> pixel (row j, column i)
        ds.PixelData = np.ascontiguousarray(data[:, :, k].T).tobytes()
        ds.save_as(out / f"IM{k:04d}.dcm", enforce_file_format=True)

    print(f"wrote {nz} slices {nx}x{ny} to {out}")
    print(f"  spacing i/j/k = {di:.5f} {dj:.5f} {dk:.5f} mm")
    print(f"  rowDir {np.round(row_dir, 4)} colDir {np.round(col_dir, 4)} kDir {np.round(k_dir, 4)}")

    if args.mask:
        lab = np.asanyarray(nib.load(args.mask).dataobj)
        if lab.shape != data.shape:
            raise SystemExit(f"mask shape {lab.shape} != image shape {data.shape}")
        idx = np.argwhere(lab > 0)
        labels = {
            "labels": sorted(int(v) for v in np.unique(lab) if v != 0),
            "voxels": int(len(idx)),
            "bboxMin": idx.min(0).tolist(),
            "bboxMax": idx.max(0).tolist(),
            "centroidIJK": idx.mean(0).round(2).tolist(),
            "toothValueMedian": float(np.median(data[lab > 0]) * slope + inter),
        }
        side = out.parent.parent / f"{out.name}.labels.json"
        side.write_text(json.dumps(labels, indent=2))
        print(f"  labels -> {side}: {labels}")


if __name__ == "__main__":
    main()
