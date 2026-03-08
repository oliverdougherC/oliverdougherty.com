import { clamp, lerp } from './utils.js';

const TRACK_VH_DESKTOP = 210;
const TRACK_VH_MOBILE = 182;

const WHEEL_IMPULSE_DESKTOP = 0.0039 / 100;
const WHEEL_IMPULSE_MOBILE = 0.0042 / 100;
const TOUCH_IMPULSE_DESKTOP = 0.0039 / 100;
const TOUCH_IMPULSE_MOBILE = 0.0042 / 100;

const VELOCITY_FRICTION = 0.88;
const MAX_VELOCITY = 0.048;
const SNAP_VELOCITY_THRESHOLD = 0.0018;
const SNAP_IDLE_DELAY_MS = 240;

const SPRING_STIFFNESS = 0.19;
const SPRING_DAMPING = 0.64;

function isPanelTarget(target) {
  return target instanceof HTMLElement
    && Boolean(target.closest('[data-lenis-prevent], .gallery-index-panel'));
}

function normalizeWheelDelta(event) {
  if (!event) return 0;
  if (event.deltaMode === 1) {
    return event.deltaY * 16;
  }
  if (event.deltaMode === 2) {
    return event.deltaY * window.innerHeight;
  }
  return event.deltaY;
}

export class InputController {
  constructor({
    shell,
    scrollTrack,
    totalItems,
    reducedMotion,
    onProgress,
    onPointerMove,
    onPointerLeave,
    onClick
  }) {
    this.shell = shell;
    this.canvas = this.shell?.querySelector('canvas') || null;
    this.scrollTrack = scrollTrack;
    this.totalItems = totalItems;
    this.reducedMotion = reducedMotion;

    this.onProgress = onProgress;
    this.onPointerMove = onPointerMove;
    this.onPointerLeave = onPointerLeave;
    this.onClick = onClick;

    this.isMobile = window.matchMedia('(max-width: 980px), (pointer: coarse)').matches;
    this.enabled = true;

    this.maxIndex = Math.max(this.totalItems - 1, 0);
    this.progressItems = 0;
    this.targetItems = 0;
    this.velocityItems = 0;
    this.springActive = false;
    this.lastImpulseAt = 0;
    this.lastMotionAt = performance.now();
    this.lastVelocityForJerk = 0;
    this.scrollJerk = 0;
    this.pointerActive = false;
    this.touchLastY = null;

    this.handleWheel = this.handleWheel.bind(this);
    this.handleTouchStart = this.handleTouchStart.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handleTouchEnd = this.handleTouchEnd.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerLeave = this.handlePointerLeave.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.handleWindowBlur = this.handleWindowBlur.bind(this);

    this.updateTrackHeight();

    window.addEventListener('resize', this.handleResize, { passive: true });
    window.addEventListener('blur', this.handleWindowBlur, { passive: true });
    window.addEventListener('wheel', this.handleWheel, { passive: true });

    this.shell?.addEventListener('touchstart', this.handleTouchStart, { passive: true });
    this.shell?.addEventListener('touchmove', this.handleTouchMove, { passive: true });
    this.shell?.addEventListener('touchend', this.handleTouchEnd, { passive: true });
    this.shell?.addEventListener('touchcancel', this.handleTouchEnd, { passive: true });

    this.canvas?.addEventListener('pointermove', this.handlePointerMove, { passive: true });
    this.canvas?.addEventListener('pointerleave', this.handlePointerLeave, { passive: true });
    this.canvas?.addEventListener('pointercancel', this.handlePointerLeave, { passive: true });
    this.shell?.addEventListener('click', this.handleClick);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this.springActive = false;
      this.velocityItems = 0;
      this.touchLastY = null;
      this.handlePointerLeave();
    }
  }

  setCurrentIndex(index) {
    const bounded = clamp(index, 0, this.maxIndex);
    this.progressItems = bounded;
    this.targetItems = bounded;
    this.velocityItems = 0;
    this.springActive = false;
  }

  handleWheel(event) {
    if (!this.enabled || isPanelTarget(event.target)) {
      return;
    }
    this.applyImpulse(normalizeWheelDelta(event), true);
  }

  handleTouchStart(event) {
    if (!this.enabled || isPanelTarget(event.target)) {
      this.touchLastY = null;
      return;
    }

    const touch = event.touches?.[0];
    this.touchLastY = touch ? touch.clientY : null;
  }

  handleTouchMove(event) {
    if (!this.enabled || isPanelTarget(event.target)) {
      this.touchLastY = null;
      return;
    }

    const touch = event.touches?.[0];
    if (!touch) return;
    if (this.touchLastY == null) {
      this.touchLastY = touch.clientY;
      return;
    }

    const deltaY = this.touchLastY - touch.clientY;
    this.touchLastY = touch.clientY;
    if (Math.abs(deltaY) < 0.2) return;

    this.applyImpulse(deltaY, true, true);
  }

  handleTouchEnd() {
    this.touchLastY = null;
  }

  applyImpulse(deltaY, fromUser = true, isTouch = false) {
    const multiplier = this.isMobile
      ? (isTouch ? TOUCH_IMPULSE_MOBILE : WHEEL_IMPULSE_MOBILE)
      : (isTouch ? TOUCH_IMPULSE_DESKTOP : WHEEL_IMPULSE_DESKTOP);

    const impulse = deltaY * multiplier;
    if (!Number.isFinite(impulse) || Math.abs(impulse) <= 1e-6) return;

    this.springActive = false;
    this.velocityItems = clamp(this.velocityItems + impulse, -MAX_VELOCITY, MAX_VELOCITY);
    this.lastMotionAt = performance.now();
    if (fromUser) {
      this.lastImpulseAt = this.lastMotionAt;
    }
  }

  handlePointerMove(event) {
    if (!this.enabled) return;
    if (!this.canvas || event.currentTarget !== this.canvas) return;

    this.pointerActive = true;
    this.onPointerMove?.({
      clientX: event.clientX,
      clientY: event.clientY
    });
  }

  handlePointerLeave() {
    if (!this.pointerActive) return;
    this.pointerActive = false;
    this.onPointerLeave?.();
  }

  handleWindowBlur() {
    this.handlePointerLeave();
    this.velocityItems = 0;
  }

  handleClick(event) {
    if (!this.enabled || !this.onClick) return;
    if (!this.canvas || event.target !== this.canvas) return;

    this.onClick({
      clientX: event.clientX,
      clientY: event.clientY
    });
  }

  handleResize() {
    this.isMobile = window.matchMedia('(max-width: 980px), (pointer: coarse)').matches;
    this.updateTrackHeight();
  }

  updateTrackHeight() {
    if (!this.scrollTrack) return;

    const minimumSlides = Math.max(this.totalItems, 1);
    const vh = this.isMobile ? TRACK_VH_MOBILE : TRACK_VH_DESKTOP;
    this.scrollTrack.style.height = `${minimumSlides * vh}vh`;
  }

  update(dtMs, now = performance.now()) {
    if (!this.enabled) {
      this.onProgress?.(this.maxIndex > 0 ? this.progressItems / this.maxIndex : 0, {
        isUserDriven: false,
        inertialVelocity: 0,
        scrollJerk: 0,
        springActive: false
      });
      return;
    }

    const dtScale = clamp((Number(dtMs) || 16.67) / 16.67, 0.5, 3);

    if (this.springActive) {
      const delta = this.targetItems - this.progressItems;
      this.velocityItems += delta * SPRING_STIFFNESS * dtScale;
      this.velocityItems *= Math.pow(SPRING_DAMPING, dtScale);
    } else {
      this.velocityItems *= Math.pow(VELOCITY_FRICTION, dtScale);
    }

    this.velocityItems = clamp(this.velocityItems, -MAX_VELOCITY, MAX_VELOCITY);

    if (Math.abs(this.velocityItems) >= SNAP_VELOCITY_THRESHOLD) {
      this.lastMotionAt = now;
    } else if (!this.springActive && (now - this.lastMotionAt) >= SNAP_IDLE_DELAY_MS) {
      this.targetItems = clamp(Math.round(this.progressItems), 0, this.maxIndex);
      this.springActive = true;
    }

    this.progressItems += this.velocityItems * dtScale;

    if (this.progressItems < 0) {
      this.progressItems = 0;
      this.velocityItems = 0;
    } else if (this.progressItems > this.maxIndex) {
      this.progressItems = this.maxIndex;
      this.velocityItems = 0;
    }

    if (this.springActive) {
      const close = Math.abs(this.targetItems - this.progressItems) <= 0.0018;
      const slow = Math.abs(this.velocityItems) <= 0.0009;
      if (close && slow) {
        this.progressItems = this.targetItems;
        this.velocityItems = 0;
        this.springActive = false;
      }
    }

    this.scrollJerk = Math.abs((this.velocityItems - this.lastVelocityForJerk) / Math.max(dtScale, 1e-3));
    this.lastVelocityForJerk = this.velocityItems;

    const progress01 = this.maxIndex > 0 ? (this.progressItems / this.maxIndex) : 0;
    this.onProgress?.(progress01, {
      isUserDriven: (now - this.lastImpulseAt) <= 280,
      inertialVelocity: this.velocityItems,
      scrollJerk: this.scrollJerk,
      springActive: this.springActive
    });
  }

  scrollToIndex(index) {
    const bounded = clamp(index, 0, this.maxIndex);
    if (this.reducedMotion) {
      this.setCurrentIndex(bounded);
      return;
    }

    this.targetItems = bounded;
    this.springActive = true;
    this.velocityItems = lerp(this.velocityItems, 0, 0.42);
  }

  dispose() {
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('blur', this.handleWindowBlur);
    window.removeEventListener('wheel', this.handleWheel);

    this.shell?.removeEventListener('touchstart', this.handleTouchStart);
    this.shell?.removeEventListener('touchmove', this.handleTouchMove);
    this.shell?.removeEventListener('touchend', this.handleTouchEnd);
    this.shell?.removeEventListener('touchcancel', this.handleTouchEnd);

    this.canvas?.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas?.removeEventListener('pointerleave', this.handlePointerLeave);
    this.canvas?.removeEventListener('pointercancel', this.handlePointerLeave);
    this.shell?.removeEventListener('click', this.handleClick);
  }
}
