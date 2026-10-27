"""Stand-in for the desktop viewer: place landmarks with ITK and save them through the API.

ITK reads the same DICOM folder the device uploaded, picks voxels, converts them to DICOM
patient coordinates (LPS mm) and POSTs them as source='desktop'. The web viewer must then
draw each one on the same anatomy (tests/cloud.test.ts checks voxel and value; this script
is for the screenshot).

Usage:
  pip install SimpleITK numpy
  python scripts/desktop_points.py <dicom_dir> <patientRef> [--api http://127.0.0.1:5191]
"""
import argparse
import json
import urllib.request

import numpy as np
import SimpleITK as sitk


def post(url, body, token=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def get(url, token):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"authorization": f"Bearer {token}"})) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dicom_dir")
    ap.add_argument("patient")
    ap.add_argument("--api", default="http://127.0.0.1:5191")
    a = ap.parse_args()

    reader = sitk.ImageSeriesReader()
    ids = reader.GetGDCMSeriesIDs(a.dicom_dir)
    series = max(ids, key=lambda s: len(reader.GetGDCMSeriesFileNames(a.dicom_dir, s)))  # the 167-slice axial here
    reader.SetFileNames(reader.GetGDCMSeriesFileNames(a.dicom_dir, series))
    img = reader.Execute()
    arr = sitk.GetArrayViewFromImage(img)  # [k, j, i]
    nx, ny, nz = img.GetSize()

    # landmarks: the brightest voxel in the middle third (enamel/metal), and the volume centre
    k0, k1 = nz // 3, 2 * nz // 3
    sub = np.asarray(arr[k0:k1])
    k, j, i = np.unravel_index(int(np.argmax(sub)), sub.shape)
    picks = {"최대밝기": (int(i), int(j), int(k + k0)), "중심": (nx // 2, ny // 2, nz // 2)}

    token = post(f"{a.api}/api/login", {"email": "dentist@a.test", "password": "dentist-a"})["token"]
    study = next(s for s in get(f"{a.api}/api/studies", token) if s["patient_ref"] == a.patient and s["status"] == "ready")
    for label, ijk in picks.items():
        lps = list(img.TransformIndexToPhysicalPoint(ijk))
        post(f"{a.api}/api/studies/{study['id']}/annotations", {"label": label, "lps": lps, "source": "desktop"}, token)
        print(f"{label}: ijk {ijk} -> LPS {np.round(lps, 3)} value {arr[ijk[2], ijk[1], ijk[0]]}")
    print("saved to study", study["id"])


if __name__ == "__main__":
    main()
