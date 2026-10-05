type Point = { x: number; y: number };
const STEP_MS = 120;
const DIRECTIONS: Record<string, Point> = {
  ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 }
};

/** Main-thread Snake stays interactive while the inference worker loads. */
export class SnakeGame {
  private context: CanvasRenderingContext2D | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private observer: ResizeObserver | null = null;
  private body: Point[] = [];
  private direction: Point = { x: 1, y: 0 };
  private nextDirection: Point = { x: 1, y: 0 };
  private food: Point = { x: 0, y: 0 };
  private dead = false;
  private destroyed = false;
  private running = false;
  private score = 0;
  private columns = 20;
  private rows = 20;
  private measuredWidth = 0;
  private measuredHeight = 0;

  constructor(private canvas: HTMLCanvasElement, private onScore: (score: number) => void = () => {}) {
    this.context = canvas.getContext('2d');
    if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => { if (this.running) this.draw(); });
      this.observer.observe(canvas);
    }
    this.measure();
    this.resetBoard();
  }

  start(): void {
    if (this.destroyed || this.running) return;
    this.running = true;
    this.canvas.ownerDocument.addEventListener('keydown', this.keydown);
    if (!this.dead) this.timer = setInterval(() => this.step(), STEP_MS);
    this.draw();
  }

  stop(): void {
    this.running = false;
    this.canvas.ownerDocument.removeEventListener('keydown', this.keydown);
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  restart(): void {
    if (this.destroyed) return;
    const running = this.running;
    this.stop();
    this.resetBoard();
    if (running) this.start();
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
    this.observer?.disconnect();
  }

  private resetBoard(): void {
    const x = Math.max(2, Math.floor(this.columns * 0.35));
    const y = Math.floor(this.rows / 2);
    this.body = [{ x, y }, { x: x - 1, y }, { x: x - 2, y }];
    this.direction = this.nextDirection = { x: 1, y: 0 };
    this.dead = false;
    this.score = 0;
    this.placeFood();
    this.onScore(0);
  }

  private keydown = (event: KeyboardEvent): void => {
    if (!this.running || event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    if (event.key === ' ' || event.key === 'Enter') {
      const control = target instanceof Element ? target.closest('button, a[href], summary, [role="button"], [role="link"]') : null;
      if (control && !this.canvas.parentElement?.contains(control)) return;
      if (this.dead) { event.preventDefault(); this.restart(); }
      return;
    }
    if (this.dead) return;
    const next = DIRECTIONS[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (!next) return;
    event.preventDefault();
    // Compare against the last committed movement, even for rapid key sequences.
    if (next.x !== -this.direction.x || next.y !== -this.direction.y) this.nextDirection = next;
  };

  private placeFood(): void {
    const free: Point[] = [];
    for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.columns; x++) {
      if (!this.body.some(point => point.x === x && point.y === y)) free.push({ x, y });
    }
    if (!free.length) { this.finish(); return; }
    this.food = free[Math.floor(Math.random() * free.length)];
  }

  private finish(): void {
    this.dead = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private step(): void {
    this.direction = this.nextDirection;
    const head = { x: this.body[0].x + this.direction.x, y: this.body[0].y + this.direction.y };
    const eating = head.x === this.food.x && head.y === this.food.y;
    const obstacles = eating ? this.body : this.body.slice(0, -1);
    if (head.x < 0 || head.y < 0 || head.x >= this.columns || head.y >= this.rows || obstacles.some(point => point.x === head.x && point.y === head.y)) {
      this.finish();
    } else {
      this.body.unshift(head);
      if (eating) { this.score++; this.onScore(this.score); this.placeFood(); }
      else this.body.pop();
    }
    this.draw();
  }

  private measure(): { width: number; height: number; ratio: number; cell: number; left: number; top: number } {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || 320;
    const height = rect.height || width;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    // Cap large displays near 48 cells per axis without making short boards tiny.
    const preferredCell = Math.max(Math.min(16, Math.min(width, height) / 8), Math.max(width, height) / 48);
    const minX = this.body.length ? Math.min(...this.body.map(point => point.x)) : 0;
    const maxX = this.body.length ? Math.max(...this.body.map(point => point.x)) : 0;
    const minY = this.body.length ? Math.min(...this.body.map(point => point.y)) : 0;
    const maxY = this.body.length ? Math.max(...this.body.map(point => point.y)) : 0;
    // Keep the whole connected body plus a movement margin; scale if it cannot fit.
    const resized = width !== this.measuredWidth || height !== this.measuredHeight;
    const rows = resized ? Math.max(8, Math.floor(height / preferredCell), maxY - minY + 3) : this.rows;
    const columns = resized ? Math.max(8, Math.floor(width / preferredCell), maxX - minX + 3) : this.columns;
    this.measuredWidth = width;
    this.measuredHeight = height;
    const changed = rows !== this.rows || columns !== this.columns;
    this.rows = rows;
    this.columns = columns;
    if (changed && this.body.length) {
      const dx = maxX >= columns - 1 ? columns - 2 - maxX : minX < 0 ? -minX : 0;
      const dy = maxY >= rows - 1 ? rows - 2 - maxY : minY < 0 ? -minY : 0;
      if (dx || dy) this.body = this.body.map(point => ({ x: point.x + dx, y: point.y + dy }));
      if (this.food.x >= columns || this.food.y >= rows || this.body.some(point => point.x === this.food.x && point.y === this.food.y)) this.placeFood();
    }
    const cell = Math.min(width / columns, height / rows) * ratio;
    const pixelsWide = Math.round(width * ratio);
    const pixelsHigh = Math.round(height * ratio);
    if (this.canvas.width !== pixelsWide) this.canvas.width = pixelsWide;
    if (this.canvas.height !== pixelsHigh) this.canvas.height = pixelsHigh;
    return { width: pixelsWide, height: pixelsHigh, ratio, cell, left: (pixelsWide - columns * cell) / 2, top: (pixelsHigh - rows * cell) / 2 };
  }

  private draw(): void {
    const ctx = this.context;
    if (!ctx) return;
    const { width, height, ratio, cell, left, top } = this.measure();
    ctx.fillStyle = '#faf8fd';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#202024';
    const foodInset = Math.min(ratio * 2, cell * 0.22);
    ctx.fillRect(left + this.food.x * cell + foodInset, top + this.food.y * cell + foodInset, cell - foodInset * 2, cell - foodInset * 2);
    ctx.fillStyle = '#7050c0';
    const inset = Math.min(ratio, cell * 0.1);
    for (const point of this.body) ctx.fillRect(left + point.x * cell + inset, top + point.y * cell + inset, cell - inset * 2, cell - inset * 2);
    if (this.dead) {
      ctx.fillStyle = 'rgba(250, 248, 253, 0.94)';
      ctx.fillRect(0, height / 2 - 24 * ratio, width, 48 * ratio);
      ctx.fillStyle = '#202024';
      ctx.font = `600 ${13 * ratio}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText(this.body.length === this.columns * this.rows ? 'Board complete!' : 'Game over', width / 2, height / 2 - 3 * ratio);
      ctx.font = `${12 * ratio}px system-ui`;
      const restartHint = width / ratio < 260 ? 'Enter to restart' : 'Space or Enter to restart';
      ctx.fillText(restartHint, width / 2, height / 2 + 15 * ratio);
    }
  }
}
