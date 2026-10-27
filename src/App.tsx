import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadSeries, type InputFile } from './dicom/load';
import { patientToVoxel, sampleNearest, voxelToPatient, type Volume } from './dicom/volume';
import { WINDOW_PRESETS } from './dicom/window';
import type { Vec3 } from './dicom/vec';
import { generatePhantom, type PhantomOptions } from './phantom/phantom';
import { MprView, measurementMm, type Measurement, type Tool } from './view/MprView';
import { filesFromDrop, readFiles } from './view/fileInput';
import { VolumeView, type RenderMode } from './three/VolumeView';
import { fitArch } from './dental/arch';
import { buildArchPath, crossSection, panorama, type Arch, type ArchPath } from './dental/panorama';
import { ImageView } from './view/ImageView';
import { directionLabel } from './dicom/mpr';
import { add, scale } from './dicom/vec';
import * as cloud from './cloud/client';

const params = new URLSearchParams(location.search);
/** ?order=naive reproduces the InstanceNumber + SliceThickness mistake (for the write-up). */
const ORDERING = params.get('order') === 'naive' ? 'naive' : 'position';

const PHANTOMS: { id: string; label: string; opts: Partial<PhantomOptions> }[] = [
  { id: 'axial', label: '팬텀 · axial', opts: { cols: 192, rows: 168, slices: 96, colSpacing: 0.4, rowSpacing: 0.533, sliceSpacing: 0.833 } },
  {
    id: 'oblique',
    label: '팬텀 · oblique + 누락 + 12bit',
    opts: { tiltDeg: 20, yawDeg: 15, missingSlices: [30], pixelRepresentation: 0, bitsStored: 12, intercept: -1024, dirtyHighBits: true },
  },
];

interface Loaded {
  vol: Volume;
  source: string;
  ms: number;
  files: number;
}

const fmt = (v: number, d = 1) => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(d);

export function App() {
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [cursor, setCursor] = useState<Vec3>([0, 0, 0]);
  const [hover, setHover] = useState<Vec3>();
  const [win, setWin] = useState({ center: 40, width: 400 });
  const [tool, setTool] = useState<Tool>('crosshair');
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [mode, setMode] = useState<RenderMode>('mip');
  const [iso, setIso] = useState(300);
  const [quality, setQuality] = useState(1.5);
  const [jitter, setJitter] = useState(true);
  const [smooth, setSmooth] = useState(false);
  const [info3d, setInfo3d] = useState('');
  const [externalSets, setExternalSets] = useState<Record<string, string[]>>({});
  const [dragOver, setDragOver] = useState(false);
  const [dental, setDental] = useState(params.get('dental') === '1');
  const [arch, setArch] = useState<Arch>();
  const [archNote, setArchNote] = useState('');
  const [csIndex, setCsIndex] = useState(0);
  const [panoThick, setPanoThick] = useState(8);
  const caps = useMemo(() => cloud.deviceCaps(), []);
  // latest values for async callbacks (level swaps arrive after the render that started them)
  const loadedRef = useRef<Loaded>(undefined);
  const cursorRef = useRef<Vec3>([0, 0, 0]);
  useEffect(() => {
    loadedRef.current = loaded;
    cursorRef.current = cursor;
  });
  const [cloudToken, setCloudToken] = useState<string>();
  const [cloudEmail, setCloudEmail] = useState('dentist@a.test');
  const [cloudPw, setCloudPw] = useState('dentist-a');
  const [studies, setStudies] = useState<cloud.StudyRow[]>([]);
  const [cloudLog, setCloudLog] = useState<string[]>([]);
  // low-spec: no WebGL2, or the browser reports <= 4 GB → keep the 1/8-size level only
  const [lowSpec, setLowSpec] = useState(!caps.webgl2 || (caps.memGB !== undefined && caps.memGB <= 4));
  const [markers, setMarkers] = useState<cloud.Annotation[]>([]);

  const vol = loaded?.vol;

  const open = useCallback(async (source: string, get: () => Promise<InputFile[]>) => {
    setBusy(`${source} 불러오는 중…`);
    setError(undefined);
    await new Promise((r) => setTimeout(r, 20)); // let the busy banner paint
    try {
      const t0 = performance.now();
      const files = await get();
      const v = loadSeries(files, { ordering: ORDERING });
      const ms = performance.now() - t0;
      setLoaded({ vol: v, source, ms, files: files.length });
      setCursor([(v.dims[0] - 1) / 2, (v.dims[1] - 1) / 2, (v.dims[2] - 1) / 2].map(Math.round) as Vec3);
      setMeasurements([]);
      setArch(undefined);
      setArchNote('');
      const isCT = v.modality === 'CT';
      setWin(v.defaultWindow ?? (isCT ? { center: 40, width: 400 } : { center: (v.min + v.max) / 2, width: v.max - v.min }));
      setIso(isCT ? 300 : v.min + (v.max - v.min) * 0.3);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }, []);

  const openPhantom = useCallback(
    (p: (typeof PHANTOMS)[number]) =>
      open(p.label, async () => {
        // Same path as user files: phantom -> DICOM bytes -> dicom-parser -> volume builder.
        const { files } = generatePhantom(p.opts);
        return files.map((f) => ({ name: f.name, bytes: f.bytes }));
      }),
    [open],
  );

  const openExternal = useCallback(
    (name: string, files: string[], sub?: string) =>
      open(`${name}${sub ? '/' + sub : ''}`, async () => {
        const list = files.filter((f) => !sub || f.startsWith(sub + '/'));
        return Promise.all(
          list.map(async (f) => {
            const r = await fetch(`/external/${name}/${f}`);
            if (!r.ok) throw new Error(`${r.status} ${f}`);
            return { name: f, bytes: await r.arrayBuffer() };
          }),
        );
      }),
    [open],
  );

  useEffect(() => {
    fetch('/external/index.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then(setExternalSets)
      .catch(() => setExternalSets({}));
    const q = new URLSearchParams(location.search).get('sample');
    const p = PHANTOMS.find((x) => x.id === q) ?? PHANTOMS[0];
    if (!q || PHANTOMS.some((x) => x.id === q)) openPhantom(p);
  }, [openPhantom]);

  // ?sample=ext:<set>[/<sub>] for screenshots
  useEffect(() => {
    const q = new URLSearchParams(location.search).get('sample');
    if (!q?.startsWith('ext:')) return;
    const [name, sub] = q.slice(4).split('/');
    if (externalSets[name]) openExternal(name, externalSets[name], sub);
  }, [externalSets, openExternal]);

  const openCloud = useCallback(
    async (target: { id: string; label: string } | { share: string; label: string }) => {
      setBusy(`클라우드 ${target.label} 불러오는 중…`);
      setError(undefined);
      setCloudLog([]);
      setMarkers([]);
      const lines: string[] = [];
      try {
        const res = await cloud.openStudy(
          cloudToken,
          'id' in target ? { id: target.id } : { share: target.share },
          ({ vol: v, level, atMs, bytes }) => {
            lines.push(`${level.factor > 1 ? `1/${level.factor ** 3} 크기` : '원본'} ${level.dims.join('×')} · ${(bytes / 1e6).toFixed(1)} MB · ${(atMs / 1000).toFixed(2)} s`);
            setCloudLog([...lines]);
            setBusy(undefined);
            // Not inside a setLoaded updater: StrictMode calls updaters twice, and a cursor
            // conversion done there ran twice — the crosshair jumped to the volume's corner.
            const prev = loadedRef.current;
            let next: Vec3;
            if (!prev || !prev.source.startsWith('클라우드')) {
              next = [(v.dims[0] - 1) / 2, (v.dims[1] - 1) / 2, (v.dims[2] - 1) / 2].map(Math.round) as Vec3;
              setWin(v.defaultWindow ?? { center: 1000, width: 4000 });
              setMeasurements([]);
            } else {
              // same anatomy under the crosshair: voxel -> LPS on the old grid -> voxel on the new one
              next = patientToVoxel(v, voxelToPatient(prev.vol, ...cursorRef.current)).map((x, a) => Math.min(v.dims[a] - 1, Math.max(0, Math.round(x)))) as Vec3;
            }
            cursorRef.current = next;
            setCursor(next);
            setArch(undefined);
            loadedRef.current = { vol: v, source: `클라우드 ${target.label}`, ms: atMs, files: 0 };
            setLoaded(loadedRef.current);
          },
          { fullResolution: !lowSpec },
        );
        setMarkers(res.annotations);
        if (lowSpec) lines.push('저사양 모드: 원본 해상도는 받지 않음');
        setCloudLog([...lines]);
      } catch (e) {
        setError(`클라우드: ${(e as Error).message}`);
        setBusy(undefined);
      }
    },
    [cloudToken, lowSpec],
  );

  useEffect(() => {
    const share = params.get('share');
    if (share) openCloud({ share, label: '공유 링크' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Points saved in LPS (desktop viewer or web) drawn where they fall within half a slice of the plane. */
  const drawMarkers = (kind: 'axial' | 'coronal' | 'sagittal') => (ctx: CanvasRenderingContext2D, toScreen: (v: Vec3) => [number, number]) => {
    if (!vol || !markers.length) return;
    const w = kind === 'axial' ? 2 : kind === 'coronal' ? 1 : 0;
    for (const m of markers) {
      const ijk = patientToVoxel(vol, m.lps);
      if (Math.abs(ijk[w] - cursor[w]) > 0.5) continue;
      const [x, y] = toScreen(ijk);
      ctx.strokeStyle = m.source === 'desktop' ? '#ff7043' : '#4dd0e1';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${m.label} (${m.source === 'desktop' ? '장비PC' : '웹'})`, x + 8, y - 8);
    }
  };

  const autoArch = useCallback((v: Volume, k: number) => {
    const fit = fitArch(v, k);
    if (!fit) {
      setArchNote('자동 추정 실패 — 축상면에서 직접 찍으세요');
      return;
    }
    setArch(fit.arch);
    setArchNote(`자동 추정: slice ${fit.arch.k0 + 1}, 상위 6% 밝기(${Math.round(fit.threshold)} 이상) 중 ${fit.inliers}/${fit.candidates}점이 포물선 ±2.5 mm 안`);
  }, []);

  // dental mode: first guess of the arch as soon as a volume is there
  useEffect(() => {
    if (dental && vol && !arch) autoArch(vol, Math.round(cursor[2]));
  }, [dental, vol, arch, autoArch]); // eslint-disable-line react-hooks/exhaustive-deps

  const archPath = useMemo((): ArchPath | undefined => {
    if (!vol || !arch || arch.points.length < 2) return undefined;
    return buildArchPath(vol, arch);
  }, [vol, arch]);
  useEffect(() => {
    if (archPath) setCsIndex(Math.floor(archPath.samples.length / 3));
  }, [archPath]);
  const pano = useMemo(() => (vol && archPath ? panorama(vol, archPath, { thicknessMm: panoThick }) : undefined), [vol, archPath, panoThick]);
  const cs = useMemo(() => (vol && archPath ? crossSection(vol, archPath, csIndex) : undefined), [vol, archPath, csIndex]);
  /** panorama / cross-section row <-> voxel k (Superior up, as in panorama()); its own inverse */
  const rowToK = (r: number) => (vol!.normal[2] > 0 ? vol!.dims[2] - 1 - r : r);

  const drawArchOnAxial = (ctx: CanvasRenderingContext2D, toScreen: (v: Vec3) => [number, number]) => {
    if (!vol || !arch) return;
    const [sx, sy] = vol.spacing;
    ctx.save();
    ctx.globalAlpha = Math.round(cursor[2]) === arch.k0 ? 0.95 : 0.45;
    ctx.strokeStyle = '#ce93d8';
    ctx.lineWidth = 1.5;
    if (archPath) {
      ctx.beginPath();
      archPath.samples.forEach((p, q) => {
        const [x, y] = toScreen([p.x / sx, p.y / sy, arch.k0]);
        if (q) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
      const c = archPath.samples[Math.min(csIndex, archPath.samples.length - 1)];
      const a = toScreen([(c.x - 15 * c.nx) / sx, (c.y - 15 * c.ny) / sy, arch.k0]);
      const b = toScreen([(c.x + 15 * c.nx) / sx, (c.y + 15 * c.ny) / sy, arch.k0]);
      ctx.strokeStyle = '#fff176';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(...a);
      ctx.lineTo(...b);
      ctx.stroke();
    }
    ctx.fillStyle = '#ce93d8';
    for (const [x, y] of arch.points) {
      const [px, py] = toScreen([x / sx, y / sy, arch.k0]);
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  const hoverInfo = useMemo(() => {
    if (!vol || !hover) return undefined;
    const p = voxelToPatient(vol, ...hover);
    return { p, hu: sampleNearest(vol, ...hover), ijk: hover.map(Math.round) };
  }, [vol, hover]);

  const cursorPatient = vol ? voxelToPatient(vol, ...cursor) : undefined;
  const r = vol?.report;
  const unit = vol?.modality === 'CT' ? 'HU' : '값';

  const externalButtons = Object.entries(externalSets).flatMap(([name, files]): { name: string; files: string[]; sub: string | undefined }[] => {
    const subs = [...new Set(files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))];
    return subs.length ? subs.map((s) => ({ name, files, sub: s })) : [{ name, files, sub: undefined }];
  });

  return (
    <div
      className={`app ${dragOver ? 'drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const dt = e.dataTransfer;
        open('드롭한 파일', async () => readFiles(await filesFromDrop(dt)));
      }}
    >
      <aside className="side">
        <h1>DICOM Web Viewer</h1>
        <p className="muted">학습용 데모 · 진단용 아님</p>

        <section>
          <h2>불러오기</h2>
          <div className="drop">폴더/파일을 화면에 끌어다 놓기</div>
          <label className="btn">
            폴더 선택
            <input
              type="file"
              multiple
              // @ts-expect-error non-standard but widely supported
              webkitdirectory=""
              hidden
              onChange={(e) => {
                const fs = [...(e.target.files ?? [])];
                if (fs.length) open('선택한 폴더', () => readFiles(fs));
              }}
            />
          </label>
          <label className="btn">
            파일 선택
            <input type="file" multiple hidden onChange={(e) => open('선택한 파일', () => readFiles([...(e.target.files ?? [])]))} />
          </label>
          <div className="row wrap">
            {PHANTOMS.map((p) => (
              <button key={p.id} onClick={() => openPhantom(p)}>
                {p.label}
              </button>
            ))}
            {externalButtons.map((b) => (
              <button key={b.name + b.sub} onClick={() => openExternal(b.name, b.files, b.sub)}>
                실데이터 · {b.name}
                {b.sub ? `/${b.sub}` : ''}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>클라우드</h2>
          {!cloudToken ? (
            <form
              className="col"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  const l = await cloud.login(cloudEmail, cloudPw);
                  setCloudToken(l.token);
                  setStudies(await cloud.listStudies(l.token));
                } catch (err) {
                  setError(`로그인: ${(err as Error).message}`);
                }
              }}
            >
              <input aria-label="이메일" value={cloudEmail} onChange={(e) => setCloudEmail(e.target.value)} />
              <input aria-label="비밀번호" type="password" value={cloudPw} onChange={(e) => setCloudPw(e.target.value)} />
              <button type="submit">로그인</button>
            </form>
          ) : (
            <>
              <div className="row wrap">
                {studies.filter((x) => x.status === 'ready').map((x) => (
                  <button key={x.id} onClick={() => openCloud({ id: x.id, label: x.patient_ref })}>
                    {x.patient_ref} · {x.file_count}파일 {(x.total_bytes / 1e6).toFixed(0)} MB
                  </button>
                ))}
                <button onClick={async () => setStudies(await cloud.listStudies(cloudToken))}>새로고침</button>
              </div>
              {studies.some((x) => x.status !== 'ready') && (
                <div className="note">{studies.filter((x) => x.status !== 'ready').map((x) => `${x.patient_ref}: ${x.status}`).join(' · ')}</div>
              )}
            </>
          )}
          <label className="check">
            <input type="checkbox" checked={lowSpec} onChange={(e) => setLowSpec(e.target.checked)} /> 저사양 모드 (저해상도만 받기)
          </label>
          <div className="note mono">
            {caps.webgl2 ? `WebGL2 · 3D 텍스처 최대 ${caps.max3d}` : 'WebGL2 없음 → 2D만'}
            {caps.memGB ? ` · 메모리 ${caps.memGB} GB` : ''} · 코어 {caps.cores}
          </div>
          {cloudLog.map((l) => (
            <div key={l} className="note mono" data-testid="cloud-log">
              {l}
            </div>
          ))}
          {markers.length > 0 && <div className="note">표시점 {markers.length}개 (장비PC {markers.filter((m) => m.source === 'desktop').length})</div>}
        </section>

        {vol && r && loaded && (
          <section className="info">
            <h2>시리즈</h2>
            <div className="kv">
              <span>출처</span>
              <b>{loaded.source}</b>
              <span>모달리티</span>
              <b>{vol.modality || '?'}</b>
              <span>크기</span>
              <b>
                {vol.dims.join(' × ')} ({r.sliceCount}장 → {vol.dims[2]})
              </b>
              <span>간격 mm</span>
              <b>{vol.spacing.map((s) => s.toFixed(3)).join(' × ')}</b>
              <span>SliceThickness</span>
              <b>{r.sliceThickness ?? '-'}</b>
              <span>법선</span>
              <b>({vol.normal.map((x) => fmt(x, 3)).join(', ')})</b>
              <span>값 범위</span>
              <b>
                {fmt(vol.min, 0)} … {fmt(vol.max, 0)} {unit} ({r.storageType})
              </b>
              <span>InstanceNumber</span>
              <b>{{ ascending: '위치와 같은 순서', descending: '위치와 반대 순서', no: '위치와 무관(무시함)', 'n/a': '-' }[r.instanceNumberMatchesPosition]}</b>
              <span>로딩</span>
              <b>
                {loaded.files}파일 {loaded.ms.toFixed(0)} ms
              </b>
            </div>
            {r.warnings.map((w) => (
              <div key={w} className="warn">
                ⚠ {w}
              </div>
            ))}
            {r.notes.map((w) => (
              <div key={w} className="note">
                {w}
              </div>
            ))}
            {r.ignoredFiles.length > 0 && (
              <details>
                <summary>제외된 파일 {r.ignoredFiles.length}개</summary>
                {r.ignoredFiles.slice(0, 50).map((f) => (
                  <div key={f.fileName} className="note">
                    {f.fileName}: {f.reason}
                  </div>
                ))}
              </details>
            )}
          </section>
        )}

        {vol && (
          <>
            <section>
              <h2>Window / Level</h2>
              <div className="row wrap">
                {WINDOW_PRESETS.map((p) => (
                  <button key={p.name} onClick={() => setWin({ center: p.center, width: p.width })}>
                    {p.name}
                  </button>
                ))}
                {vol.defaultWindow && <button onClick={() => setWin(vol.defaultWindow!)}>파일 기본값</button>}
              </div>
              <div className="muted small">
                W {Math.round(win.width)} / L {Math.round(win.center)} · 우클릭(또는 Shift+좌) 드래그로 조절
              </div>
            </section>

            <section>
              <h2>도구</h2>
              <div className="row">
                <button className={tool === 'crosshair' ? 'on' : ''} onClick={() => setTool('crosshair')}>
                  십자선
                </button>
                <button className={tool === 'measure' ? 'on' : ''} onClick={() => setTool('measure')}>
                  거리 측정
                </button>
                <button onClick={() => setMeasurements([])} disabled={!measurements.length}>
                  측정 지우기
                </button>
              </div>
              <label className="check">
                <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} /> MPR 화면 보간(smoothing)
              </label>
              {measurements.map((m) => (
                <div key={m.id} className="note mono">
                  #{m.id} {m.view}: {measurementMm(vol, m).toFixed(2)} mm
                </div>
              ))}
              <div className="muted small">휠: 슬라이스 · Ctrl+휠: 확대 · 더블클릭: 맞춤</div>
            </section>

            <section>
              <h2>치과 (파노라마)</h2>
              <div className="row wrap">
                <button className={dental ? 'on' : ''} onClick={() => setDental((d) => !d)}>
                  치과 모드
                </button>
                <button disabled={!dental} onClick={() => autoArch(vol, Math.round(cursor[2]))}>
                  치열궁 자동 추정
                </button>
                <button
                  disabled={!dental}
                  className={tool === 'arch' ? 'on' : ''}
                  onClick={() => {
                    setTool('arch');
                    setArch({ k0: Math.round(cursor[2]), points: [] });
                    setArchNote('축상면에서 치열궁을 따라 한쪽 끝부터 차례로 클릭 (2점 이상)');
                  }}
                >
                  직접 찍기
                </button>
              </div>
              {dental && (
                <>
                  <label className="slider">
                    파노라마 두께 {panoThick} mm
                    <input type="range" min={1} max={20} step={1} value={panoThick} onChange={(e) => setPanoThick(+e.target.value)} />
                  </label>
                  {archPath && (
                    <div className="note mono">
                      치열궁 길이 {archPath.lengthMm.toFixed(1)} mm · 단면 위치 {(csIndex * archPath.step).toFixed(1)} mm
                    </div>
                  )}
                  {archNote && <div className="note">{archNote}</div>}
                  <div className="muted small">파노라마 클릭: 단면 위치 · 단면 위 휠: 1 mm 이동</div>
                </>
              )}
            </section>

            <section>
              <h2>3D</h2>
              <div className="row">
                <button className={mode === 'mip' ? 'on' : ''} onClick={() => setMode('mip')}>
                  MIP
                </button>
                <button className={mode === 'iso' ? 'on' : ''} onClick={() => setMode('iso')}>
                  ISO 표면
                </button>
              </div>
              {mode === 'iso' && (
                <label className="slider">
                  임계값 {Math.round(iso)} {unit}
                  <input type="range" min={vol.min} max={vol.max} step={1} value={iso} onChange={(e) => setIso(+e.target.value)} />
                </label>
              )}
              <label className="slider">
                샘플/복셀 {quality.toFixed(2)}
                <input type="range" min={0.25} max={3} step={0.25} value={quality} onChange={(e) => setQuality(+e.target.value)} />
              </label>
              <label className="check">
                <input type="checkbox" checked={jitter} onChange={(e) => setJitter(e.target.checked)} /> 레이 시작점 지터(나뭇결 무늬 제거)
              </label>
              <div className="muted small">{info3d}</div>
            </section>
          </>
        )}
      </aside>

      <main className="main">
        <div className="status mono" data-testid="status">
          {busy ?? error ?? (
            <>
              {cursorPatient && (
                <span>
                  십자선 LPS ({cursorPatient.map((x) => fmt(x)).join(', ')}) mm
                </span>
              )}
              {hoverInfo ? (
                <span>
                  {' '}
                  · 커서 LPS ({hoverInfo.p.map((x) => fmt(x)).join(', ')}) mm · ijk ({hoverInfo.ijk.join(', ')}) ·{' '}
                  <b>
                    {hoverInfo.hu === undefined ? '-' : fmt(hoverInfo.hu, Number.isInteger(hoverInfo.hu) ? 0 : 2)} {unit}
                  </b>
                </span>
              ) : (
                <span className="muted"> · 영상 위에 마우스를 올리면 좌표/{unit} 표시</span>
              )}
            </>
          )}
        </div>
        {error && <div className="error">{error}</div>}
        {vol ? (
          <div className={`grid ${dental ? 'dental' : ''}`}>
            {(dental ? (['axial', 'sagittal'] as const) : (['axial', 'coronal', 'sagittal'] as const)).map((k) => (
              <MprView
                key={k}
                vol={vol}
                kind={k}
                cursor={cursor}
                onCursor={setCursor}
                onHover={setHover}
                win={win}
                onWindow={setWin}
                tool={tool}
                measurements={measurements}
                onMeasure={(m) => setMeasurements((ms) => [...ms, { ...m, id: (ms.at(-1)?.id ?? 0) + 1 }])}
                smooth={smooth}
                overlay={(ctx, toScreen) => {
                  if (dental && k === 'axial') drawArchOnAxial(ctx, toScreen);
                  drawMarkers(k)(ctx, toScreen);
                }}
                onArchPoint={(v) =>
                  setArch((a) => ({ k0: a?.k0 ?? Math.round(v[2]), points: [...(a?.points ?? []), [v[0] * vol.spacing[0], v[1] * vol.spacing[1]]] }))
                }
              />
            ))}
            {dental && pano && archPath && (
              <ImageView
                testId="panorama"
                title="Panorama"
                color="#ce93d8"
                img={pano}
                win={win}
                min={vol.min}
                max={vol.max}
                onPick={(x, y) => {
                  const q = Math.min(archPath.samples.length - 1, Math.max(0, Math.round(x - 0.5)));
                  setCsIndex(q);
                  const p = archPath.samples[q];
                  setCursor([Math.round(p.x / vol.spacing[0]), Math.round(p.y / vol.spacing[1]), Math.round(rowToK(y - 0.5))]);
                }}
                overlay={(ctx, l, size) => {
                  const [x] = l.toScreen(csIndex + 0.5, 0);
                  ctx.strokeStyle = '#fff176';
                  ctx.lineWidth = 1.5;
                  ctx.beginPath();
                  ctx.moveTo(x, l.toScreen(0, 0)[1]);
                  ctx.lineTo(x, l.toScreen(0, pano.height)[1]);
                  ctx.stroke();
                  const [, y] = l.toScreen(0, rowToK(cursor[2]) + 0.5);
                  ctx.strokeStyle = '#4fc3f7';
                  ctx.globalAlpha = 0.6;
                  ctx.beginPath();
                  ctx.moveTo(l.toScreen(0, 0)[0], y);
                  ctx.lineTo(l.toScreen(pano.width, 0)[0], y);
                  ctx.stroke();
                  ctx.globalAlpha = 1;
                  // which end of the arch is which side of the patient, from the direction cosines
                  const s0 = archPath.samples[0];
                  const s1 = archPath.samples[archPath.samples.length - 1];
                  const along = add(scale(vol.rowDir, s1.x - s0.x), scale(vol.colDir, s1.y - s0.y));
                  ctx.fillStyle = '#ddd';
                  ctx.font = 'bold 13px system-ui, sans-serif';
                  ctx.textAlign = 'center';
                  // dominant letter only: the ends of an arch also run posterior, which is not the point here
                  ctx.fillText(directionLabel(scale(along, -1))[0], 12, size.h / 2);
                  ctx.fillText(directionLabel(along)[0], size.w - 12, size.h / 2);
                  ctx.textAlign = 'left';
                }}
              />
            )}
            {dental && cs && archPath && (
              <ImageView
                testId="cross-section"
                title={`Cross-section @ ${(csIndex * archPath.step).toFixed(1)} mm`}
                color="#fff176"
                img={cs}
                win={win}
                min={vol.min}
                max={vol.max}
                onWheel={(d) =>
                  setCsIndex((q) => Math.min(archPath.samples.length - 1, Math.max(0, q + d * Math.max(1, Math.round(1 / archPath.step)))))
                }
                overlay={(ctx, l, size) => {
                  const [, y] = l.toScreen(0, rowToK(cursor[2]) + 0.5);
                  ctx.strokeStyle = '#4fc3f7';
                  ctx.globalAlpha = 0.6;
                  ctx.beginPath();
                  ctx.moveTo(l.toScreen(0, 0)[0], y);
                  ctx.lineTo(l.toScreen(cs.width, 0)[0], y);
                  ctx.stroke();
                  ctx.globalAlpha = 1;
                  ctx.fillStyle = '#ddd';
                  ctx.font = 'bold 12px system-ui, sans-serif';
                  ctx.textAlign = 'center';
                  ctx.fillText('설측', 18, size.h / 2);
                  ctx.fillText('협측', size.w - 18, size.h / 2);
                  ctx.textAlign = 'left';
                }}
              />
            )}
            {caps.webgl2 ? (
              <VolumeView vol={vol} mode={mode} win={win} iso={iso} cursor={cursor} quality={quality} jitter={jitter} onInfo={setInfo3d} />
            ) : (
              <div className="view" data-view="3d">
                <div className="empty">이 PC는 WebGL2를 지원하지 않아 3D를 끄고 2D 단면만 표시합니다</div>
              </div>
            )}
          </div>
        ) : (
          <div className="empty">{busy ?? '시리즈를 불러오세요'}</div>
        )}
      </main>
    </div>
  );
}
