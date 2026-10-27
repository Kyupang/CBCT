import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { voxelToPatient, type Volume } from '../dicom/volume';
import type { Vec3 } from '../dicom/vec';
import { buildTextureVolume, type TextureVolume } from './volumeTexture';
import { fragmentShader, vertexShader } from './raymarch';

export type RenderMode = 'mip' | 'iso';

interface Props {
  vol: Volume;
  mode: RenderMode;
  win: { center: number; width: number };
  iso: number;
  cursor: Vec3;
  quality: number; // samples per voxel along the ray
  jitter: boolean;
  onInfo?: (s: string) => void;
}

export function VolumeView({ vol, mode, win, iso, cursor, quality, jitter, onInfo }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    render: () => void;
  } | undefined>(undefined);
  const [err, setErr] = useState<string>();

  // renderer lifetime = component lifetime
  useEffect(() => {
    const el = wrapRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    } catch (e) {
      setErr(`WebGL2 unavailable: ${(e as Error).message}`);
      return;
    }
    if (!renderer.capabilities.isWebGL2) setErr('WebGL2 required');
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x000000);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    camera.up.set(0, 0, 1); // patient Superior up (LPS +z)
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    const render = () => renderer.render(scene, camera);
    controls.addEventListener('change', render);
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      render();
    });
    ro.observe(el);
    ctxRef.current = { renderer, scene, camera, controls, render };
    return () => {
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      ctxRef.current = undefined;
    };
  }, []);

  const tex: TextureVolume | undefined = useMemo(() => {
    const c = ctxRef.current;
    const max3D = c ? c.renderer.getContext().getParameter((c.renderer.getContext() as WebGL2RenderingContext).MAX_3D_TEXTURE_SIZE) : 2048;
    return buildTextureVolume(vol, max3D as number);
  }, [vol]);

  const objs = useRef<{ mesh: THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial>; marker: THREE.Mesh; texture: THREE.Data3DTexture } | undefined>(undefined);

  // (re)build texture + mesh when the volume changes
  useEffect(() => {
    const c = ctxRef.current;
    if (!c || !tex) return;
    const texture = new THREE.Data3DTexture(tex.data, tex.dims[0], tex.dims[1], tex.dims[2]);
    texture.format = THREE.RedFormat;
    texture.type = THREE.HalfFloatType;
    texture.internalFormat = 'R16F';
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;

    const extent = new THREE.Vector3(tex.dims[0] * tex.spacing[0], tex.dims[1] * tex.spacing[1], tex.dims[2] * tex.spacing[2]);
    const f = tex.factor;
    const centerVox = tex.dims.map((n) => (n * f - 1) / 2) as Vec3;
    const center = new THREE.Vector3(...voxelToPatient(vol, ...centerVox));
    // local unit cube -> patient LPS mm: translate * [rowDir colDir normal] * scale(extent)
    const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...vol.rowDir), new THREE.Vector3(...vol.colDir), new THREE.Vector3(...vol.normal));
    const m = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z).multiply(basis).multiply(new THREE.Matrix4().makeScale(extent.x, extent.y, extent.z));

    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      uniforms: {
        uVolume: { value: texture },
        uCamLocal: { value: new THREE.Vector3() },
        uTexSize: { value: new THREE.Vector3(...tex.dims) },
        uExtent: { value: extent },
        uMode: { value: 0 },
        uWinLo: { value: 0 },
        uWinHi: { value: 1 },
        uIso: { value: 300 },
        uStepsPerVoxel: { value: 1.5 },
        uJitter: { value: 1 },
      },
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(m);
    mesh.matrixWorld.copy(m);
    const inv = new THREE.Matrix4().copy(m).invert();
    mesh.onBeforeRender = (_r, _s, cam) => {
      material.uniforms.uCamLocal.value.copy(cam.position).applyMatrix4(inv);
    };
    c.scene.add(mesh);

    const r = Math.max(Math.min(...vol.spacing), extent.length() * 0.008);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff4081, depthTest: false }));
    marker.renderOrder = 2;
    c.scene.add(marker);

    // camera: look from patient Anterior (−y in LPS), Superior up
    const diag = extent.length();
    c.controls.target.copy(center);
    c.camera.position.copy(center).add(new THREE.Vector3(0, -diag * 1.45, 0));
    c.camera.near = diag * 0.05;
    c.camera.far = diag * 10;
    c.camera.updateProjectionMatrix();
    c.controls.update();
    objs.current = { mesh, marker, texture };
    onInfo?.(
      `3D 텍스처 ${tex.dims.join('×')} R16F = ${(tex.bytes / 1048576).toFixed(1)} MB` + (tex.factor > 1 ? ` (1/${tex.factor} 다운샘플)` : ''),
    );
    c.render();
    return () => {
      c.scene.remove(mesh, marker);
      mesh.geometry.dispose();
      material.dispose();
      texture.dispose();
      marker.geometry.dispose();
      (marker.material as THREE.Material).dispose();
      objs.current = undefined;
    };
  }, [vol, tex]); // eslint-disable-line react-hooks/exhaustive-deps

  // uniforms
  useEffect(() => {
    const c = ctxRef.current;
    const o = objs.current;
    if (!c || !o) return;
    const u = o.mesh.material.uniforms;
    u.uMode.value = mode === 'mip' ? 0 : 1;
    u.uWinLo.value = win.center - win.width / 2;
    u.uWinHi.value = win.center + win.width / 2;
    u.uIso.value = iso;
    u.uStepsPerVoxel.value = quality;
    u.uJitter.value = jitter ? 1 : 0;
    o.marker.position.set(...voxelToPatient(vol, ...cursor));
    c.render();
  }, [vol, tex, mode, win.center, win.width, iso, cursor, quality, jitter]);

  return (
    <div ref={wrapRef} className="view view3d" data-view="3d">
      <div className="view-title" style={{ color: '#f48fb1' }}>
        3D {mode === 'mip' ? 'MIP' : `ISO ≥ ${Math.round(iso)}`}
      </div>
      {err && <div className="view-error">{err}</div>}
    </div>
  );
}
