import * as THREE from 'three';
import { gsap } from 'gsap';
import { fragmentShader, vertexShader } from './shaders.js';
import { clamp, lerp } from './utils.js';

const TEXTURE_LOAD_TIMEOUT_MS = 15000;

function createRoundedPlaneGeometry(radius = 0.11, curveSegments = 12) {
  const halfWidth = 0.5;
  const halfHeight = 0.5;
  const safeRadius = Math.min(radius, halfWidth, halfHeight);

  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + safeRadius, -halfHeight);
  shape.lineTo(halfWidth - safeRadius, -halfHeight);
  shape.quadraticCurveTo(halfWidth, -halfHeight, halfWidth, -halfHeight + safeRadius);
  shape.lineTo(halfWidth, halfHeight - safeRadius);
  shape.quadraticCurveTo(halfWidth, halfHeight, halfWidth - safeRadius, halfHeight);
  shape.lineTo(-halfWidth + safeRadius, halfHeight);
  shape.quadraticCurveTo(-halfWidth, halfHeight, -halfWidth, halfHeight - safeRadius);
  shape.lineTo(-halfWidth, -halfHeight + safeRadius);
  shape.quadraticCurveTo(-halfWidth, -halfHeight, -halfWidth + safeRadius, -halfHeight);

  const geometry = new THREE.ShapeGeometry(shape, curveSegments);
  geometry.computeBoundingBox();

  const bbox = geometry.boundingBox;
  const position = geometry.attributes.position;
  const uv = new Float32Array(position.count * 2);
  const width = Math.max((bbox?.max.x || 0) - (bbox?.min.x || 0), 1e-5);
  const height = Math.max((bbox?.max.y || 0) - (bbox?.min.y || 0), 1e-5);

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    uv[i * 2] = (x - (bbox?.min.x || 0)) / width;
    uv[i * 2 + 1] = (y - (bbox?.min.y || 0)) / height;
  }

  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

const FRONT_GEOMETRY = createRoundedPlaneGeometry();
const BACK_GEOMETRY = createRoundedPlaneGeometry();

let sharedFallback = null;

function getSharedFallbackTexture() {
  if (!sharedFallback) {
    const pixel = new Uint8Array([236, 236, 234, 255]);
    sharedFallback = new THREE.DataTexture(pixel, 1, 1, THREE.RGBAFormat);
    sharedFallback.needsUpdate = true;
    sharedFallback.colorSpace = THREE.SRGBColorSpace;
  }
  return sharedFallback;
}

export class GalleryItem {
  constructor({ entry, textureLoader, maxAnisotropy = 1, qualityLevel = 1, isMobile = false }) {
    this.entry = entry;
    this.textureLoader = textureLoader;
    this.maxAnisotropy = maxAnisotropy;
    this.aspect = entry.aspect || 1.5;
    this.highResLoaded = false;
    this.highResRequested = false;

    this.isMobile = Boolean(isMobile);
    this.worldThickness = this.isMobile ? 0.056 : 0.094;
    this.depthPhase = 0;
    this.qualityFactor = 1;

    this.uniforms = {
      u_image: { value: getSharedFallbackTexture() },
      u_res: { value: new THREE.Vector2(1600, Math.round(1600 / this.aspect)) },
      u_planeRes: { value: new THREE.Vector2(420, 280) },
      u_opacity: { value: 1 },
      u_tintStrength: { value: 0.008 },
      u_glossStrength: { value: 0.042 },
      u_edgeBoost: { value: 0.08 },
      u_edgeTint: { value: new THREE.Color('#b6b2f2') },
      u_edgeTintStrength: { value: 0.12 },
      u_desaturate: { value: 0.08 },
      u_hoverMix: { value: 0 },
      u_time: { value: 0 }
    };

    this.photoMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthTest: true,
      depthWrite: true,
      side: THREE.DoubleSide
    });

    this.shadowMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#020207'),
      transparent: true,
      opacity: 0,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    this.backPaneMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#0e1018'),
      transparent: true,
      opacity: 0.024,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    this.rimMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#b9b4ff'),
      transparent: true,
      opacity: 0.026,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });

    this.glazeMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#f7f8ff'),
      transparent: true,
      opacity: 0.016,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });

    this.shadowMesh = new THREE.Mesh(BACK_GEOMETRY, this.shadowMaterial);
    this.backPaneMesh = new THREE.Mesh(BACK_GEOMETRY, this.backPaneMaterial);
    this.photoFrontMesh = new THREE.Mesh(FRONT_GEOMETRY, this.photoMaterial);
    this.rimMesh = new THREE.Mesh(FRONT_GEOMETRY, this.rimMaterial);
    this.glazeMesh = new THREE.Mesh(FRONT_GEOMETRY, this.glazeMaterial);

    this.photoFrontMesh.userData.galleryItem = this;
    this.rimMesh.userData.galleryItem = this;
    this.glazeMesh.userData.galleryItem = this;
    this.backPaneMesh.userData.galleryItem = this;

    this.root = new THREE.Group();
    this.root.userData.galleryItem = this;
    this.root.add(this.shadowMesh);
    this.root.add(this.backPaneMesh);
    this.root.add(this.photoFrontMesh);
    this.root.add(this.rimMesh);
    this.root.add(this.glazeMesh);

    this.mesh = this.root;
    this.interactionMesh = this.photoFrontMesh;

    this.frontPhotoMesh = this.photoFrontMesh;
    this.edgeShellMesh = this.glazeMesh;
    this.backGlassMesh = this.backPaneMesh;

    this.currentOpacity = 1;
    this.currentDimensions = { width: 420, height: 280 };

    this.setQualityLevel(qualityLevel);
    this.loadThumbTexture();
  }

  getRaycastTarget() {
    return this.interactionMesh;
  }

  setViewportMode(isMobile) {
    this.isMobile = Boolean(isMobile);
    this.worldThickness = this.isMobile ? 0.056 : 0.094;
  }

  loadThumbTexture() {
    const candidates = [
      this.entry.src?.thumb,
      this.entry.src?.medium,
      this.entry.src?.large
    ].filter(Boolean);

    if (!candidates.length) return;
    this._loadTextureFromSourceList(candidates).catch(() => {});
  }

  loadHighResTexture() {
    if (this.highResRequested || this.highResLoaded) return;
    this.highResRequested = true;

    const candidates = [
      this.entry.src?.avif,
      this.entry.src?.webp,
      this.entry.src?.large,
      this.entry.src?.medium
    ].filter(Boolean);

    if (!candidates.length) return;

    this._loadTextureFromSourceList(candidates)
      .then(() => {
        this.highResLoaded = true;
      })
      .catch(() => {
        // Keep currently loaded texture when high-res candidates fail.
      });
  }

  async _loadTextureFromSourceList(sources) {
    const unique = [...new Set(sources.filter(Boolean))];
    if (!unique.length) {
      throw new Error('No texture sources provided.');
    }

    for (const src of unique) {
      try {
        await this._loadTextureFromSrc(src);
        return;
      } catch (_error) {
        // Try next candidate.
      }
    }

    throw new Error('All texture source candidates failed.');
  }

  _loadTextureFromSrc(src) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const fail = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      };

      const timer = setTimeout(() => {
        fail(new Error(`Texture load timed out after ${TEXTURE_LOAD_TIMEOUT_MS}ms: ${src}`));
      }, TEXTURE_LOAD_TIMEOUT_MS);

      this.textureLoader.load(
        src,
        (texture) => {
          if (settled) {
            texture.dispose();
            return;
          }

          settled = true;
          clearTimeout(timer);

          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.magFilter = THREE.LinearFilter;
          texture.anisotropy = Math.max(1, Math.min(this.maxAnisotropy, 4));

          const previous = this.uniforms.u_image.value;
          this.uniforms.u_image.value = texture;

          if (texture.image && texture.image.width && texture.image.height) {
            this.aspect = texture.image.width / texture.image.height;
            this.uniforms.u_res.value.set(texture.image.width, texture.image.height);
          }

          if (previous && previous !== texture && previous !== sharedFallback) {
            previous.dispose();
          }

          resolve();
        },
        undefined,
        () => fail(new Error(`Texture load failed: ${src}`))
      );
    });
  }

  updateShaderProfile() {
    this.uniforms.u_tintStrength.value = lerp(0.006, 0.016, this.depthPhase) * this.qualityFactor;
    this.uniforms.u_glossStrength.value = lerp(0.03, 0.086, this.depthPhase) * lerp(0.82, 1, this.qualityFactor);
    this.uniforms.u_edgeBoost.value = lerp(0.05, 0.18, this.depthPhase);
    this.uniforms.u_edgeTintStrength.value = lerp(0.07, 0.22, this.depthPhase);
    this.uniforms.u_desaturate.value = lerp(0.38, 0.04, this.depthPhase);
  }

  setQualityLevel(level) {
    this.qualityFactor = Math.min(1, Math.max(0.35, Number(level) || 1));
    this.updateShaderProfile();
  }

  setTransform(transform) {
    const scale = Number.isFinite(transform.scale) ? transform.scale : 1;
    const width = transform.height * this.aspect * scale;
    const height = transform.height * scale;
    const isFocused = Boolean(transform.focused);

    this.currentDimensions.width = width;
    this.currentDimensions.height = height;

    this.root.position.set(transform.x, transform.y, transform.z);
    this.root.rotation.set(transform.rotX, transform.rotY, transform.rotZ);

    this.shadowMesh.scale.set(width * 1.065, height * 1.05, 1);
    this.shadowMesh.position.set(width * 0.018, -height * 0.036, -this.worldThickness * 1.45);

    this.backPaneMesh.scale.set(width * 1.012, height * 1.012, 1);
    this.backPaneMesh.position.set(0, 0, -this.worldThickness);

    this.photoFrontMesh.scale.set(width, height, 1);
    this.photoFrontMesh.position.set(0, 0, 0);

    this.rimMesh.scale.set(width * 1.017, height * 1.017, 1);
    this.rimMesh.position.set(0, 0, this.worldThickness * 0.22);

    this.glazeMesh.scale.set(width * 1.009, height * 1.009, 1);
    this.glazeMesh.position.set(0, 0, this.worldThickness * 0.46);

    this.uniforms.u_planeRes.value.set(width, height);
    this.uniforms.u_opacity.value = isFocused ? 1 : transform.opacity;
    this.currentOpacity = transform.opacity;

    const phase = clamp(this.depthPhase, 0, 1);
    this.shadowMaterial.opacity = transform.opacity * (isFocused ? 0.14 : lerp(0.026, 0.11, phase));
    this.backPaneMaterial.opacity = transform.opacity * (isFocused ? 0.082 : lerp(0.028, 0.082, phase));
    this.rimMaterial.opacity = transform.opacity * (isFocused ? 0.18 : lerp(0.05, 0.18, phase));
    this.glazeMaterial.opacity = transform.opacity * (isFocused ? 0.092 : lerp(0.028, 0.084, phase));

    this.root.visible = transform.visible && transform.opacity > 0.008;
  }

  setDepthProfile(profile) {
    this.depthPhase = Math.min(1, Math.max(0, profile.depthPhase ?? 0));
    this.updateShaderProfile();
  }

  setHoverState(isHovering) {
    gsap.to(this.uniforms.u_hoverMix, {
      value: isHovering ? 1 : 0,
      duration: isHovering ? 0.3 : 0.22,
      ease: isHovering ? 'power2.out' : 'power2.inOut',
      overwrite: true
    });
  }

  update(time) {
    this.uniforms.u_time.value = time;
  }

  dispose() {
    gsap.killTweensOf(this.uniforms.u_hoverMix);

    this.photoMaterial.dispose();
    this.shadowMaterial.dispose();
    this.backPaneMaterial.dispose();
    this.rimMaterial.dispose();
    this.glazeMaterial.dispose();

    const texture = this.uniforms.u_image.value;
    if (texture && texture !== sharedFallback) {
      texture.dispose();
    }
  }
}
