// Both backends render the same signed-distance gyroid sculpture. Geometry,
// normals, occlusion and reflected lighting are calculated for every pixel.
export function gpuSceneGlsl(webgl2: boolean, highPrecision = true) {
  return `${webgl2 ? '#version 300 es' : ''}
precision ${highPrecision ? 'highp' : 'mediump'} float;
uniform vec4 u_scene;
uniform vec2 u_pointer;
uniform vec2 u_sample;
${webgl2 ? 'out vec4 out_color;' : ''}
float field(vec3 p) {
  vec3 q = p * 3.7;
  float gyroid = dot(sin(q), cos(q.yzx));
  return max((abs(gyroid) - 0.27) / 6.4, abs(length(p) - 1.27) - 0.41);
}
vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.002, 0.0);
  return normalize(vec3(field(p + e.xyy) - field(p - e.xyy),
    field(p + e.yxy) - field(p - e.yxy), field(p + e.yyx) - field(p - e.yyx)));
}
void main() {
  vec2 jitter = fract((u_sample.x + 1.0) * vec2(0.754877666, 0.569840296)) - 0.5;
  vec2 uv = (gl_FragCoord.xy + jitter - 0.5 * u_scene.yz) / min(u_scene.y, u_scene.z);
  float angle = u_scene.x * 0.13 + u_pointer.x * 1.8;
  float elevation = 0.32 + u_pointer.y * 0.8;
  vec3 ro = vec3(sin(angle) * cos(elevation), sin(elevation), cos(angle) * cos(elevation)) * 7.2;
  vec3 forward = normalize(-ro);
  vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, forward);
  vec3 rd = normalize(forward * 1.6 + right * uv.x + up * uv.y);
  float travel = 0.0;
  float glow = 0.0;
  bool hit = false;
  for (int i = 0; i < 150; i++) {
    float d = field(ro + rd * travel);
    glow += 0.0014 * exp(-abs(d) * 22.0);
    if (d < 0.0017) { hit = true; break; }
    travel += max(d * 0.68, 0.001);
    if (travel > 12.0) break;
  }
  vec3 color = vec3(0.969, 0.969, 0.961);
  if (hit) {
    vec3 p = ro + rd * travel;
    vec3 n = normalAt(p);
    vec3 light = normalize(vec3(-3.0, 4.0, 3.0));
    float diffuse = max(dot(n, light), 0.0);
    float ao = clamp(1.0 - (0.06 - field(p + n * 0.06)) * 4.0
      - (0.18 - field(p + n * 0.18)) * 1.8, 0.15, 1.0);
    float fresnel = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    float specular = pow(max(dot(reflect(-light, n), -rd), 0.0), 42.0);
    float bands = 0.5 + 0.5 * sin(p.y * 3.4 + p.x * 1.7 + u_scene.x * 0.25);
    vec3 metal = mix(vec3(0.10, 0.055, 0.18), vec3(0.44, 0.28, 0.73), bands);
    color = metal * (0.15 + diffuse * 0.75) * ao;
    color += vec3(0.91, 0.88, 0.97) * specular * 1.6;
    color += mix(vec3(0.21, 0.13, 0.35), vec3(0.60, 0.44, 0.86), bands) * fresnel * 0.8;
    color += vec3(0.045, 0.025, 0.08) * glow;
    color = pow(color / (vec3(1.0) + color), vec3(0.4545));
  }
  ${webgl2 ? 'out_color' : 'gl_FragColor'} = vec4(color / max(u_sample.y, 1.0), 1.0);
}`;
}

export const gpuSceneWgsl = `
struct Settings { scene: vec4<f32>, pointer: vec4<f32> };
@group(0) @binding(0) var<uniform> settings: Settings;
fn field(p: vec3<f32>) -> f32 {
  let q = p * 3.7;
  let gyroid = dot(sin(q), cos(q.yzx));
  return max((abs(gyroid) - 0.27) / 6.4, abs(length(p) - 1.27) - 0.41);
}
fn normalAt(p: vec3<f32>) -> vec3<f32> {
  let e = vec2<f32>(0.002, 0.0);
  return normalize(vec3<f32>(field(p + e.xyy) - field(p - e.xyy),
    field(p + e.yxy) - field(p - e.yxy), field(p + e.yyx) - field(p - e.yyx)));
}
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}
@fragment fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let s = settings.scene;
  let uv = (vec2<f32>(position.x, s.z - position.y) - 0.5 * s.yz) / min(s.y, s.z);
  let angle = s.x * 0.13 + settings.pointer.x * 1.8;
  let elevation = 0.32 + settings.pointer.y * 0.8;
  let ro = vec3<f32>(sin(angle) * cos(elevation), sin(elevation), cos(angle) * cos(elevation)) * 7.2;
  let forward = normalize(-ro);
  let right = normalize(cross(forward, vec3<f32>(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  let rd = normalize(forward * 1.6 + right * uv.x + up * uv.y);
  var travel = 0.0;
  var glow = 0.0;
  var hit = false;
  for (var i = 0u; i < 150u; i++) {
    let d = field(ro + rd * travel);
    glow += 0.0014 * exp(-abs(d) * 22.0);
    if (d < 0.0017) { hit = true; break; }
    travel += max(d * 0.68, 0.001);
    if (travel > 12.0) { break; }
  }
  var color = vec3<f32>(0.969, 0.969, 0.961);
  if (hit) {
    let p = ro + rd * travel;
    let n = normalAt(p);
    let light = normalize(vec3<f32>(-3.0, 4.0, 3.0));
    let diffuse = max(dot(n, light), 0.0);
    let ao = clamp(1.0 - (0.06 - field(p + n * 0.06)) * 4.0
      - (0.18 - field(p + n * 0.18)) * 1.8, 0.15, 1.0);
    let fresnel = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    let specular = pow(max(dot(reflect(-light, n), -rd), 0.0), 42.0);
    let bands = 0.5 + 0.5 * sin(p.y * 3.4 + p.x * 1.7 + s.x * 0.25);
    let metal = mix(vec3<f32>(0.10, 0.055, 0.18), vec3<f32>(0.44, 0.28, 0.73), bands);
    color = metal * (0.15 + diffuse * 0.75) * ao;
    color += vec3<f32>(0.91, 0.88, 0.97) * specular * 1.6;
    color += mix(vec3<f32>(0.21, 0.13, 0.35), vec3<f32>(0.60, 0.44, 0.86), bands) * fresnel * 0.8;
    color += vec3<f32>(0.045, 0.025, 0.08) * glow;
    color = pow(color / (vec3<f32>(1.0) + color), vec3<f32>(0.4545));
  }
  return vec4<f32>(color, 1.0);
}`;

export const gpuComputeWgsl = `
struct Settings { scene: vec4<f32>, pointer: vec4<f32> };
@group(0) @binding(0) var<storage, read_write> state: array<vec4<f32>>;
@group(0) @binding(1) var<uniform> settings: Settings;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  // One invocation owns one element. No modulo aliasing or concurrent writes.
  if (id.x >= arrayLength(&state)) { return; }
  var a = state[id.x] + vec4<f32>(0.13, 0.37, 0.61, 0.89) + f32(id.x) * 0.000001;
  var b = a.wzyx + vec4<f32>(0.17, 0.23, 0.41, 0.73);
  for (var i = 0u; i < u32(settings.pointer.z); i++) {
    a = fract(fma(a, b.yzwx + vec4<f32>(1.37), b.wxyz * 0.73));
    b = fract(fma(b, a.zwxy + vec4<f32>(1.79), a.yxwz * 0.61));
    a = sqrt(a + vec4<f32>(0.01)) * 0.91;
    b = sin(b + a) * 0.49 + vec4<f32>(0.5);
  }
  state[id.x] = fract(a + b);
}`;
