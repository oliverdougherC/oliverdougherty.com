import * as THREE from 'three';

const DEFAULT_QUALITY = {
  ultra: { dpr: 1.5, qualityLevel: 1, grain: 0.0016, exposure: 0.99 },
  high: { dpr: 1.25, qualityLevel: 0.82, grain: 0.0013, exposure: 0.99 },
  medium: { dpr: 1, qualityLevel: 0.66, grain: 0.00105, exposure: 1.0 },
  mobile: { dpr: 0.85, qualityLevel: 0.48, grain: 0.00095, exposure: 1.0 }
};

// Pointer coordinates placed outside NDC range [-1, 1] so raycasts hit nothing when the cursor is off-screen.
const POINTER_OFF_SCREEN = new THREE.Vector2(5, 5);

export class WebGL {
  constructor({ canvas, perspective = 800, qualityName = 'ultra', qualityMap = DEFAULT_QUALITY }) {
    this.canvas = canvas;
    this.perspective = perspective;
    this.qualityMap = qualityMap;
    this.qualityName = qualityName;
    this.contextLost = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5200);
    this.camera.position.z = this.perspective;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance'
    });

    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping || THREE.ACESFilmicToneMapping;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.pointer = POINTER_OFF_SCREEN.clone();
    this.raycaster = new THREE.Raycaster();

    this.viewport = {
      width: window.innerWidth,
      height: window.innerHeight
    };

    this._onContextLost = this._onContextLost.bind(this);
    this._onContextRestored = this._onContextRestored.bind(this);
    this.canvas.addEventListener('webglcontextlost', this._onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this._onContextRestored);

    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(document.documentElement);

    this.handleResize();
    this.setQualityProfile(this.qualityName);
  }

  _onContextLost(event) {
    event.preventDefault();
    this.contextLost = true;
    console.warn('WebGL context lost - rendering paused.');
  }

  _onContextRestored() {
    this.contextLost = false;
    this.setQualityProfile(this.qualityName);
    console.info('WebGL context restored - rendering resumed.');
  }

  getQualityProfile(name = this.qualityName) {
    return this.qualityMap[name] || this.qualityMap.ultra;
  }

  setQualityProfile(name) {
    this.qualityName = name;
    const profile = this.getQualityProfile(name);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, profile.dpr));
    this.renderer.toneMappingExposure = profile.exposure;
    this.renderer.setSize(this.viewport.width, this.viewport.height, false);
  }

  getMaxAnisotropy() {
    return this.renderer.capabilities.getMaxAnisotropy();
  }

  setPointer(clientX, clientY) {
    this.pointer.x = (clientX / this.viewport.width) * 2 - 1;
    this.pointer.y = -(clientY / this.viewport.height) * 2 + 1;
  }

  clearPointer() {
    this.pointer.copy(POINTER_OFF_SCREEN);
  }

  isPointerActive() {
    return this.pointer.x >= -1 && this.pointer.x <= 1 && this.pointer.y >= -1 && this.pointer.y <= 1;
  }

  handleResize() {
    this.viewport.width = window.innerWidth;
    this.viewport.height = window.innerHeight;

    this.renderer.setSize(this.viewport.width, this.viewport.height, false);

    const fov = (180 * (2 * Math.atan(window.innerHeight / 2 / this.perspective))) / Math.PI;
    this.camera.fov = fov;
    this.camera.aspect = this.viewport.width / this.viewport.height;
    this.camera.position.z = this.perspective;
    this.camera.updateProjectionMatrix();
  }

  raycast(targets) {
    if (!targets.length) return null;
    if (!this.isPointerActive()) return null;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersections = this.raycaster.intersectObjects(targets, false);
    if (!intersections.length) return null;

    const hit = intersections[0];
    const item = hit.object.userData.galleryItem;
    if (!item) return null;

    return {
      item,
      uv: hit.uv || null,
      point: hit.point
    };
  }

  render() {
    if (this.contextLost) return;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }
}

export { DEFAULT_QUALITY };
