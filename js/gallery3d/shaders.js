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
uniform float u_tintStrength;
uniform float u_glossStrength;
uniform float u_edgeBoost;
uniform vec3 u_edgeTint;
uniform float u_edgeTintStrength;
uniform float u_desaturate;
uniform float u_hoverMix;
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

void main() {
  vec2 uv = coverUv(vUv, u_res, u_planeRes);
  vec3 photo = texture2D(u_image, uv).rgb;
  float luminance = dot(photo, vec3(0.2126, 0.7152, 0.0722));
  photo = mix(photo, vec3(luminance), clamp(u_desaturate, 0.0, 0.9));

  float border = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  float outerEdge = 1.0 - smoothstep(0.015, 0.12, border);
  float innerEdge = 1.0 - smoothstep(0.05, 0.22, border);
  float vignette = smoothstep(0.94, 0.24, distance(vUv, vec2(0.5)));

  float topBand = smoothstep(0.1, 0.68, 0.84 - vUv.y + (0.5 - abs(vUv.x - 0.5)) * 0.12 + sin(u_time * 0.14) * 0.01);
  float diagonalSheen = smoothstep(0.065, 0.0, abs((vUv.x - 0.18) * 0.8 + (vUv.y - 0.2) * 0.32));
  float sideCatch = smoothstep(0.08, 0.0, abs(vUv.x - 0.08)) * smoothstep(0.0, 0.82, 1.0 - vUv.y);
  float hoverBoost = 1.0 + (u_hoverMix * 0.5);

  vec3 color = pow(photo, vec3(0.985));
  color *= mix(0.955, 1.0, vignette);
  color += u_edgeTint * innerEdge * u_edgeTintStrength * 0.22;
  color = mix(color, color + (u_edgeTint * 0.65), clamp(topBand * u_tintStrength * 2.2, 0.0, 0.18));
  color += vec3(1.0) * topBand * u_glossStrength * 0.2;
  color += mix(vec3(1.0), u_edgeTint, 0.4) * diagonalSheen * u_glossStrength * 0.28 * hoverBoost;
  color += vec3(1.0) * sideCatch * (u_glossStrength * 0.16 + u_hoverMix * 0.02);
  color += u_edgeTint * outerEdge * u_edgeBoost * 0.44;
  color += vec3(1.0) * outerEdge * u_edgeBoost * 0.18;

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), clamp(u_opacity, 0.0, 1.0));
}
`;
