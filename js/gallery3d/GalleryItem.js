import * as THREE from 'three';
import { gsap } from 'gsap';
import { fragmentShader, vertexShader } from './shaders.js';

const TEXTURE_LOAD_TIMEOUT_MS = 15000;
const FRONT_GEOMETRY = new THREE.PlaneGeometry(1, 1, 1, 1);
const BACK_GEOMETRY = new THREE.PlaneGeometry(1, 1, 1, 1);

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
    this.worldThickness = this.isMobile ? 0.08 : 0.12;
    this.depthPhase = 0;

    this.uniforms = {
      u_image: { value: getSharedFallbackTexture() },
      u_res: { value: new THREE.Vector2(1600, Math.round(1600 / this.aspect)) },
      u_planeRes: { value: new THREE.Vector2(420, 280) },
      u_opacity: { value: entry.overview?.alpha ?? 1 },
      u_cornerRadius: { value: 0.065 },
      u_edgeSoftness: { value: 0.0065 },
      u_tintStrength: { value: 0.012 },
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

    this.glazeMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#ffffff'),
      transparent: true,
      opacity: 0.065,
      depthTest: true,
      depthWrite: false
    });

    this.backPaneMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#e8e8e6'),
      transparent: true,
      opacity: 0.028,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    this.photoFrontMesh = new THREE.Mesh(FRONT_GEOMETRY, this.photoMaterial);
    this.glazeMesh = new THREE.Mesh(FRONT_GEOMETRY, this.glazeMaterial);
    this.backPaneMesh = new THREE.Mesh(BACK_GEOMETRY, this.backPaneMaterial);

    this.photoFrontMesh.userData.galleryItem = this;
    this.glazeMesh.userData.galleryItem = this;
    this.backPaneMesh.userData.galleryItem = this;

    this.root = new THREE.Group();
    this.root.userData.galleryItem = this;
    this.root.add(this.backPaneMesh);
    this.root.add(this.photoFrontMesh);
    this.root.add(this.glazeMesh);

    this.mesh = this.root;
    this.interactionMesh = this.photoFrontMesh;

    // Backward-compatible aliases used by diagnostics.
    this.frontPhotoMesh = this.photoFrontMesh;
    this.edgeShellMesh = this.glazeMesh;
    this.backGlassMesh = this.backPaneMesh;

    this.currentOpacity = entry.overview?.alpha ?? 1;
    this.currentDimensions = { width: 420, height: 280 };

    this.setQualityLevel(qualityLevel);
    this.loadThumbTexture();
  }

  getRaycastTarget() {
    return this.interactionMesh;
  }

  setViewportMode(isMobile) {
    this.isMobile = Boolean(isMobile);
    this.worldThickness = this.isMobile ? 0.08 : 0.12;
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

  setQualityLevel(level) {
    const clamped = Math.min(1, Math.max(0.35, Number(level) || 1));
    this.uniforms.u_tintStrength.value = 0.008 + (1 - clamped) * 0.02;
  }

  setTransform(transform) {
    const scale = Number.isFinite(transform.scale) ? transform.scale : 1;
    const width = transform.height * this.aspect * scale;
    const height = transform.height * scale;

    this.currentDimensions.width = width;
    this.currentDimensions.height = height;

    this.root.position.set(transform.x, transform.y, transform.z);
    this.root.rotation.set(transform.rotX, transform.rotY, transform.rotZ);

    this.photoFrontMesh.scale.set(width, height, 1);
    this.photoFrontMesh.position.set(0, 0, 0.016);

    this.glazeMesh.scale.set(width * 1.002, height * 1.002, 1);
    this.glazeMesh.position.set(0, 0, 0.036);

    this.backPaneMesh.scale.set(width * 0.996, height * 0.996, 1);
    this.backPaneMesh.position.set(0, 0, -0.01);

    const minDim = Math.max(Math.min(width, height), 1);
    const cornerRadius = Math.min(0.14, Math.max(0.03, (minDim * 0.095) / minDim));

    this.uniforms.u_planeRes.value.set(width, height);
    this.uniforms.u_cornerRadius.value = cornerRadius;
    this.uniforms.u_opacity.value = transform.opacity;
    this.currentOpacity = transform.opacity;

    this.backPaneMaterial.opacity = 0.018 + this.depthPhase * 0.012;
    this.glazeMaterial.opacity = 0.038 + this.depthPhase * 0.042;

    this.root.visible = transform.visible && transform.opacity > 0.012;
  }

  setDepthProfile(profile) {
    this.depthPhase = Math.min(1, Math.max(0, profile.depthPhase ?? 0));
    this.uniforms.u_tintStrength.value = 0.004 + this.depthPhase * 0.028;
  }

  setHoverState(isHovering) {
    gsap.to(this.uniforms.u_tintStrength, {
      value: isHovering ? 0.05 : 0.016,
      duration: isHovering ? 0.34 : 0.22,
      ease: isHovering ? 'power2.out' : 'power2.inOut',
      overwrite: true
    });
  }

  update(time) {
    this.uniforms.u_time.value = time;
  }

  dispose() {
    gsap.killTweensOf(this.uniforms.u_tintStrength);

    this.photoMaterial.dispose();
    this.glazeMaterial.dispose();
    this.backPaneMaterial.dispose();

    const texture = this.uniforms.u_image.value;
    if (texture && texture !== sharedFallback) {
      texture.dispose();
    }
  }
}
