export const vertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const fragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_res;
uniform vec2 u_planeRes;
uniform float u_opacity;
uniform float u_cornerRadius;
uniform float u_edgeSoftness;
uniform float u_tintStrength;
uniform float u_time;

varying vec2 vUv;

vec2 coverUv(vec2 uv, vec2 textureSize, vec2 planeSize) {
  float textureRatio = textureSize.x / max(textureSize.y, 1.0);
  float planeRatio = planeSize.x / max(planeSize.y, 1.0);
  vec2 scaled = uv;

  if (planeRatio < textureRatio) {
    float sx = planeRatio / textureRatio;
    scaled.x = uv.x * sx + (1.0 - sx) * 0.5;
  } else {
    float sy = textureRatio / planeRatio;
    scaled.y = uv.y * sy + (1.0 - sy) * 0.5;
  }

  return scaled;
}

float roundedMask(vec2 uv, float radius, float edgeSoftness) {
  vec2 centered = uv - 0.5;
  float aspect = max(u_planeRes.x / max(u_planeRes.y, 1.0), 0.001);
  if (aspect >= 1.0) {
    centered.x *= aspect;
  } else {
    centered.y /= aspect;
  }

  vec2 halfSize = vec2(0.5);
  if (aspect >= 1.0) {
    halfSize.x *= aspect;
  } else {
    halfSize.y /= aspect;
  }

  vec2 q = abs(centered) - (halfSize - vec2(radius));
  float sdf = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  return 1.0 - smoothstep(-edgeSoftness, edgeSoftness, sdf);
}

void main() {
  vec2 uv = coverUv(vUv, u_res, u_planeRes);

  float radius = clamp(u_cornerRadius, 0.01, 0.2);
  float edgeSoft = clamp(u_edgeSoftness, 0.0012, 0.02);
  float mask = roundedMask(vUv, radius, edgeSoft);

  if (mask <= 0.001) {
    discard;
  }

  vec3 photo = texture2D(u_image, uv).rgb;

  float pulse = sin(u_time * 0.5) * 0.5 + 0.5;
  float tintAmount = clamp(u_tintStrength + pulse * 0.004, 0.0, 0.08);
  vec3 softened = mix(photo, vec3(dot(photo, vec3(0.299, 0.587, 0.114))), 0.02);
  vec3 color = mix(softened, vec3(1.0), tintAmount);

  gl_FragColor = vec4(color, clamp(u_opacity, 0.0, 1.0) * mask);
}
`;
