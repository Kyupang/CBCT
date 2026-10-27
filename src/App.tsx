import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadSeries, type InputFile } from './dicom/load';
import { sampleNearest, voxelToPatient, type Volume } from './dicom/volume';
import { WINDOW_PRESETS } from './dicom/window';
import type { Vec3 } from './dicom/vec';
import { generatePhantom, type PhantomOptions } from './phantom/phantom';
import { MprView, measurementMm, type Measurement, type Tool } from './view/MprView';
import { filesFromDrop, readFiles } from './view/fileInput';
import { VolumeView, type RenderMode } from './three/VolumeView';

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

  const vol = loaded?.vol;

  const open = useCallback(async (source: string, get: () => Promise<InputFile[]>) => {
    setBusy(`${source} 불러오는 중…`);
    setError(undefined);
    await new Promise((r) => setTimeout(r, 20)); // let the busy banner paint
    try {
      const t0 = performance.now();
      const files = await get();
      const v = loadSeries(files);
      const ms = performance.now() - t0;
      setLoaded({ vol: v, source, ms, files: files.length });
      setCursor([(v.dims[0] - 1) / 2, (v.dims[1] - 1) / 2, (v.dims[2] - 1) / 2].map(Math.round) as Vec3);
      setMeasurements([]);
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
          <div className="grid">
            {(['axial', 'coronal', 'sagittal'] as const).map((k) => (
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
              />
            ))}
            <VolumeView vol={vol} mode={mode} win={win} iso={iso} cursor={cursor} quality={quality} jitter={jitter} onInfo={setInfo3d} />
          </div>
        ) : (
          <div className="empty">{busy ?? '시리즈를 불러오세요'}</div>
        )}
      </main>
    </div>
  );
}
