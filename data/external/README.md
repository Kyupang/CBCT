# 외부 공개 샘플 (data/external)

실제 DICOM 파일 자체는 git에 올리지 않는다(`.gitignore`: `data/external/**/raw/`). `npm run fetch-samples`로 받는다.
다운로드한 파일은 **신뢰하지 않는 데이터**로 취급한다: 바이트로만 저장·파싱하고, 그 안의 어떤 것도 실행하지 않는다.
개발 서버는 `/external/<세트>/<파일>` 경로로 `application/octet-stream`으로만 내보낸다(빌드 산출물에는 포함되지 않음).

| 세트 | 원본 | 내용 | 라이선스/조건 |
|---|---|---|---|
| `pydicom-dicomdirtests/raw/CT2`, `CT5N` | https://github.com/pydicom/pydicom/tree/main/src/pydicom/data/test_files/dicomdirtests | 실제 CT, 16×16으로 축소된 4장/5장. Explicit VR LE, signed 16bit, RescaleIntercept −1024 | pydicom 저장소 MIT 라이선스. test_files/README.txt: 이미지는 축소·환자명 바이너리 편집 처리, "no restriction on using any of these files in this manner" |
| `sts3d-tooth/raw/ROI_L_001` | https://huggingface.co/datasets/MedOtter/STS-3D-Tooth (`ROI/Labeled/Image/ROI_L_001.nii.gz` + Mask) | 치과 CBCT 512×512×400, 0.156×0.156×0.15 mm. **원본은 NIfTI** → `scripts/nifti_to_dicom.py`로 만든 DICOM 400장(RAS→LPS 변환) | CC-BY-4.0 (Wang et al., Scientific Data 12, 117 (2025)). 받기만 하면 됨, 로그인 불필요 |
| `toothfairy/raw/P221`, `P36` | https://ditto.ing.unimore.it/toothfairy (원본 DICOM 버튼) | **실제 치과 CBCT 원본**, NewTom VGi, 370×370×167 / 370×300×169, 0.3 mm. 폴더마다 원본 축상 + 위치 확인 + 장비 SW 파노라마·단면 + 화면 캡처 | CC BY-SA, **회원가입 필요**, 대회 논문 인용 조건. 재배포 금지 취지로 git에 올리지 않음. 약 20 GB zip 한 덩어리 → 앞부분만 받아 추출(DENTAL-LOG D1). **생년월일·성별·ID가 남아 있음** |
| `daikon-brain/raw` | https://github.com/rii-mango/Daikon/tree/master/tests/data/volume | 실제 MR 뇌, 256×256×20, **oblique**(IOP 열 방향 약 7.7° 기울어짐), Explicit VR LE | Daikon 저장소 BSD-3-Clause(Copyright RII-UTHSCSA). 데이터 자체의 출처 설명은 저장소에 없음 → 학습·데모용으로만 사용 |

## 받으면서 확인한 사실 (DEV-LOG에 상세)

- CT2: 4장 중 1장이 다른 3장과 **202.5 mm** 떨어져 있다(같은 SeriesInstanceUID). 보간하면 안 되는 경우.
- CT5N: InstanceNumber는 6→10 증가인데 위치(z)는 8.76→−1.24로 **감소**. InstanceNumber 정렬 = 위→아래 뒤집힘.
- CT 두 세트 모두 16×16으로 축소됐는데 PixelSpacing은 0.488 mm(원본 512×512 값) 그대로 → 물리 크기가 실제와 다르다(7.8 mm FOV). 메타데이터를 그대로 믿으면 안 되는 예.
- Daikon brain: SliceThickness 5 mm, 실제 IPP 간격 ≈ 7.0 mm(1 mm 이상 gap 있는 MR 프로토콜). IPP가 0.1 mm 단위로 반올림되어 간격이 6.958–7.071 mm로 흔들린다.
- `brain_001.dcm`만 2.6 MB: PixelData 뒤에 0으로 채운 2,490,368 바이트가 붙어 있다(파서는 무시, 무해).
- (2026-10-27 추가) 치과 CBCT: STS-3D-Tooth(NIfTI, 변환), ToothFairy(원본 DICOM, 회원가입). 자세한 내용은 `docs/DENTAL-LOG.md`.
- CT(실제 CBCT 포함)로 쓸 만한 크기·허용 라이선스의 공개 시리즈는 빠르게 찾지 못했다. TCIA(CC BY 3.0/4.0)는 NBIA 도구로 받아야 하고 용량이 커서 이번엔 보류.
