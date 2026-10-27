/**
 * Single-pass raymarcher in the box's local frame (unit cube [-0.5, 0.5]^3).
 * The box is drawn with BackSide so the camera may sit inside it.
 */
export const vertexShader = /* glsl */ `
out vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const fragmentShader = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec3 vLocal;
out vec4 outColor;
uniform sampler3D uVolume;
uniform vec3 uCamLocal;
uniform vec3 uTexSize;   // voxels
uniform vec3 uExtent;    // mm
uniform int uMode;       // 0 = MIP, 1 = ISO surface
uniform float uWinLo;
uniform float uWinHi;
uniform float uIso;
uniform float uStepsPerVoxel;
uniform float uJitter;

const int MAX_STEPS = 2048;

vec2 hitBox(vec3 o, vec3 d) {
  vec3 inv = 1.0 / d;
  vec3 t0 = (vec3(-0.5) - o) * inv;
  vec3 t1 = (vec3(0.5) - o) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

float sampleHU(vec3 p) { return texture(uVolume, p + 0.5).r; }

// gradient in HU per mm (central differences, one texel apart)
vec3 gradient(vec3 p) {
  vec3 h = 1.0 / uTexSize;
  vec3 g = vec3(
    sampleHU(p + vec3(h.x, 0, 0)) - sampleHU(p - vec3(h.x, 0, 0)),
    sampleHU(p + vec3(0, h.y, 0)) - sampleHU(p - vec3(0, h.y, 0)),
    sampleHU(p + vec3(0, 0, h.z)) - sampleHU(p - vec3(0, 0, h.z)));
  return g / (2.0 * h * uExtent);
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 dir = normalize(vLocal - uCamLocal);
  vec2 t = hitBox(uCamLocal, dir);
  float t0 = max(t.x, 0.0);
  float t1 = t.y;
  if (t1 <= t0) discard;

  // step so that we take ~uStepsPerVoxel samples per voxel along this direction
  float voxelsAlongRay = length(dir * uTexSize) * (t1 - t0);
  int n = int(clamp(ceil(voxelsAlongRay * uStepsPerVoxel), 1.0, float(MAX_STEPS)));
  float dt = (t1 - t0) / float(n);
  // jittered start breaks the "wood grain" rings from a fixed sampling lattice
  float tt = t0 + dt * (uJitter > 0.5 ? hash(gl_FragCoord.xy) : 0.5);

  if (uMode == 0) {
    float m = -1e9;
    for (int i = 0; i < MAX_STEPS; i++) {
      if (i >= n) break;
      m = max(m, sampleHU(uCamLocal + dir * tt));
      tt += dt;
    }
    float g = clamp((m - uWinLo) / max(uWinHi - uWinLo, 1.0), 0.0, 1.0);
    outColor = vec4(vec3(g), 1.0);
    return;
  }

  float prevT = tt;
  float prevV = sampleHU(uCamLocal + dir * tt);
  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= n) break;
    tt += dt;
    float v = sampleHU(uCamLocal + dir * tt);
    if (v >= uIso && prevV < uIso) {
      // bisection between prevT and tt for a crisper surface
      float a = prevT, b = tt;
      for (int k = 0; k < 6; k++) {
        float mid = 0.5 * (a + b);
        if (sampleHU(uCamLocal + dir * mid) >= uIso) b = mid; else a = mid;
      }
      vec3 p = uCamLocal + dir * b;
      vec3 nrm = normalize(-gradient(p));
      vec3 viewMm = normalize(-dir * uExtent); // towards the camera, in the mm-scaled local frame
      float diff = abs(dot(nrm, viewMm));
      float spec = pow(max(dot(reflect(-viewMm, nrm), viewMm), 0.0), 24.0);
      vec3 base = vec3(0.93, 0.89, 0.80);
      outColor = vec4(base * (0.18 + 0.82 * diff) + 0.25 * spec, 1.0);
      return;
    }
    prevT = tt;
    prevV = v;
  }
  discard;
}
`;
