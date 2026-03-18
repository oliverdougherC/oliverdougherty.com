import { clamp, lerp } from './utils.js';

const TRACK_VH_DESKTOP = 136;
const TRACK_VH_MOBILE = 118;

const INPUT_DELTA_CAP_DESKTOP = 460;
const INPUT_DELTA_CAP_MOBILE = 380;

const WHEEL_IMPULSE_DESKTOP = 0.0009;
const WHEEL_IMPULSE_MOBILE = 0.00102;
const TOUCH_IMPULSE_DESKTOP = 0.0019;
const TOUCH_IMPULSE_MOBILE = 0.00215;

const TARGET_FRICTION = 0.44;
const TARGET_STOP_THRESHOLD = 0.0014;
const MAX_INERTIAL_VELOCITY = 0.38;

const SNAP_IDLE_DELAY_MS = 72;

const SPRING_STIFFNESS = 0.33;
const SPRING_DAMPING = 0.58;
const FAST_SNAP_STIFFNESS = 0.48;
const FAST_SNAP_DAMPING = 0.48;
const FAST_SNAP_KICK = 0.07;
const DIRECTIONAL_SNAP_THRESHOLD = 0.32;

function isPanelTarget(target) {
  if (document.body?.classList.contains('nav-open')) {
    return true;
  }

  return target instanceof HTMLElement
    && Boolean(
      target.closest(
        [
          '[data-lenis-prevent]',
          '.gallery-index-panel',
          '.gallery-hud',
          '.gallery-footer',
          '.nav',
          '.nav-overlay',
          'button',
          'a',
          'input',
          'textarea'
        ].join(', ')
      )
    );
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
    this.springVelocityItems = 0;
    this.springActive = false;
    this.lastImpulseAt = 0;
    this.lastMotionAt = performance.now();
    this.lastVelocityForJerk = 0;
    this.scrollJerk = 0;
    this.lastIntentDirection = 0;
    this.pointerActive = false;
    this.touchLastY = null;
    this.springProfile = 'default';
    this.springStiffness = SPRING_STIFFNESS;
    this.springDamping = SPRING_DAMPING;
    this.maxVelocity = MAX_INERTIAL_VELOCITY;

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
      this.springVelocityItems = 0;
      this.touchLastY = null;
      this.handlePointerLeave();
    }
  }

  setCurrentIndex(index) {
    const bounded = clamp(index, 0, this.maxIndex);
    this.progressItems = bounded;
    this.targetItems = bounded;
    this.velocityItems = 0;
    this.springVelocityItems = 0;
    this.springActive = false;
    this.lastIntentDirection = 0;
    this.setSpringProfile('default');
  }

  setSpringProfile(mode = 'default') {
    if (mode === 'fastSnap') {
      this.springProfile = 'fastSnap';
      this.springStiffness = FAST_SNAP_STIFFNESS;
      this.springDamping = FAST_SNAP_DAMPING;
      this.maxVelocity = MAX_INERTIAL_VELOCITY;
      return;
    }

    this.springProfile = 'default';
    this.springStiffness = SPRING_STIFFNESS;
    this.springDamping = SPRING_DAMPING;
    this.maxVelocity = MAX_INERTIAL_VELOCITY;
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
    const deltaCap = this.isMobile ? INPUT_DELTA_CAP_MOBILE : INPUT_DELTA_CAP_DESKTOP;
    const normalized = clamp(deltaY, -deltaCap, deltaCap);
    const multiplier = this.isMobile
      ? (isTouch ? TOUCH_IMPULSE_MOBILE : WHEEL_IMPULSE_MOBILE)
      : (isTouch ? TOUCH_IMPULSE_DESKTOP : WHEEL_IMPULSE_DESKTOP);

    const impulse = normalized * multiplier;
    if (!Number.isFinite(impulse) || Math.abs(impulse) <= 1e-6) return;

    this.setSpringProfile('default');
    this.springActive = false;
    const targetGain = isTouch ? 0.5 : 0.42;
    const velocityGain = isTouch ? 0.56 : 0.42;
    this.lastIntentDirection = Math.sign(impulse) || this.lastIntentDirection;
    this.targetItems = clamp(this.targetItems + impulse * targetGain, 0, this.maxIndex);
    this.velocityItems = clamp(this.velocityItems + (impulse * velocityGain), -this.maxVelocity, this.maxVelocity);
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
    this.springVelocityItems = 0;
    this.lastIntentDirection = 0;
    this.targetItems = clamp(Math.round(this.progressItems), 0, this.maxIndex);
    this.progressItems = this.targetItems;
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

    const dtScale = clamp((Number(dtMs) || 16.67) / 16.67, 0.55, 2.6);

    if (Math.abs(this.velocityItems) > TARGET_STOP_THRESHOLD) {
      this.targetItems = clamp(this.targetItems + this.velocityItems * dtScale, 0, this.maxIndex);
      this.velocityItems *= Math.pow(TARGET_FRICTION, dtScale);
      this.lastMotionAt = now;
    } else {
      this.velocityItems = 0;
    }

    if (!this.springActive && (now - this.lastMotionAt) >= SNAP_IDLE_DELAY_MS) {
      const baseFloor = Math.floor(this.targetItems);
      const baseCeil = Math.ceil(this.targetItems);
      const remainder = this.targetItems - baseFloor;
      let snapped = Math.round(this.targetItems);

      if (this.lastIntentDirection > 0 && remainder >= DIRECTIONAL_SNAP_THRESHOLD) {
        snapped = baseCeil;
      } else if (this.lastIntentDirection < 0 && remainder <= (1 - DIRECTIONAL_SNAP_THRESHOLD)) {
        snapped = baseFloor;
      }

      this.targetItems = clamp(snapped, 0, this.maxIndex);
      this.springActive = true;
    }

    const delta = this.targetItems - this.progressItems;
    this.springVelocityItems += delta * this.springStiffness * dtScale;
    this.springVelocityItems *= Math.pow(this.springDamping, dtScale);
    this.progressItems += this.springVelocityItems * dtScale;

    if (this.progressItems < 0) {
      this.progressItems = 0;
      this.targetItems = 0;
      this.velocityItems = 0;
      this.springVelocityItems = 0;
    } else if (this.progressItems > this.maxIndex) {
      this.progressItems = this.maxIndex;
      this.targetItems = this.maxIndex;
      this.velocityItems = 0;
      this.springVelocityItems = 0;
    }

    if (this.springActive) {
      const close = Math.abs(this.targetItems - this.progressItems) <= 0.0018;
      const slow = Math.abs(this.springVelocityItems) <= 0.0008 && Math.abs(this.velocityItems) <= 0.0008;
      if (close && slow) {
        this.progressItems = this.targetItems;
        this.velocityItems = 0;
        this.springVelocityItems = 0;
        this.springActive = false;
        this.lastIntentDirection = 0;
        this.setSpringProfile('default');
      }
    }

    const reportedVelocity = this.springVelocityItems + this.velocityItems;
    this.scrollJerk = Math.abs((reportedVelocity - this.lastVelocityForJerk) / Math.max(dtScale, 1e-3));
    this.lastVelocityForJerk = reportedVelocity;

    const progress01 = this.maxIndex > 0 ? (this.progressItems / this.maxIndex) : 0;
    this.onProgress?.(progress01, {
      isUserDriven: (now - this.lastImpulseAt) <= 260,
      inertialVelocity: reportedVelocity,
      scrollJerk: this.scrollJerk,
      springActive: this.springActive
    });
  }

  scrollToIndex(index, options = {}) {
    const bounded = clamp(index, 0, this.maxIndex);
    if (this.reducedMotion) {
      this.setCurrentIndex(bounded);
      return;
    }

    const mode = options?.mode === 'fastSnap' ? 'fastSnap' : 'default';
    this.setSpringProfile(mode);
    this.springActive = true;
    this.targetItems = bounded;
    this.velocityItems = 0;
    this.lastIntentDirection = Math.sign(bounded - this.progressItems);

    if (mode === 'fastSnap') {
      const direction = Math.sign(bounded - this.progressItems);
      this.springVelocityItems = clamp(
        this.springVelocityItems + direction * FAST_SNAP_KICK,
        -0.44,
        0.44
      );
    } else {
      this.springVelocityItems = lerp(this.springVelocityItems, 0, 0.35);
    }

    this.lastMotionAt = performance.now();
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
