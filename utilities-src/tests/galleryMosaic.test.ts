/**
 * Mosaic solver/layout invariants for js/gallery.js (review F06): every
 * accepted non-empty input must yield every archive card exactly once, at
 * finite aspect-preserving dimensions, without overlaps, with consistent
 * gutter accounting, and with a guaranteed fallback when the course DP has no
 * legal partition. Runs the real script against the real manifest and against
 * synthetic aspect sets.
 */
import {
  loadDesktopGallery,
  makePhoto,
  readRealManifest,
  flushFrames,
  type DesktopHarness
} from './galleryHarness';

interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  mediaHeight: number;
  domIndex: number;
}

// Matches the gallery's pre-retune placard allowance in box arithmetic.
const PLACARD = 34;

function readBoxes(h: DesktopHarness): Box[] {
  return [...h.grid.querySelectorAll<HTMLElement>('.photo-card')].map((card, domIndex) => {
    const media = card.querySelector<HTMLElement>('.photo-media');
    return {
      id: card.dataset.entryId as string,
      x: parseFloat(card.style.left),
      y: parseFloat(card.style.top),
      width: parseFloat(card.style.width),
      mediaHeight: parseFloat(media?.style.height as string),
      domIndex
    };
  });
}

function gapX(width: number): number {
  return Math.min(Math.max(width * 0.021, 14), 26);
}

function assertPlacement(boxes: Box[], containerWidth: number, expectedIds: string[]) {
  expect(boxes.map((box) => box.id).sort()).toEqual([...expectedIds].sort());

  for (const box of boxes) {
    expect([box.x, box.y, box.width, box.mediaHeight].every(Number.isFinite)).toBe(true);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(containerWidth + 3);
    expect(box.width).toBeGreaterThan(0);
    expect(box.mediaHeight).toBeGreaterThan(0);
  }

  // DOM order is the reading order the layout appends in.
  for (let i = 1; i < boxes.length; i += 1) {
    const prev = boxes[i - 1];
    const next = boxes[i];
    const inOrder = next.y > prev.y || (next.y === prev.y && next.x >= prev.x);
    expect(inOrder).toBe(true);
  }

  // No pairwise overlap beyond 1px of rounding (card = media + placard).
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY =
        Math.min(a.y + a.mediaHeight + PLACARD, b.y + b.mediaHeight + PLACARD) -
        Math.max(a.y, b.y);
      if (overlapX > 1 && overlapY > 1) {
        throw new Error(
          `overlap: ${a.id} [${a.x},${a.y},${a.width}x${a.mediaHeight}] vs ` +
            `${b.id} [${b.x},${b.y},${b.width}x${b.mediaHeight}]`
        );
      }
    }
  }
}

function assertGutters(boxes: Box[], containerWidth: number) {
  const rows = new Map<number, Box[]>();
  for (const box of boxes) {
    const row = rows.get(box.y) || [];
    row.push(box);
    rows.set(box.y, row);
  }
  const expected = gapX(containerWidth);
  for (const row of rows.values()) {
    if (row.length < 2) continue;
    const sorted = [...row].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].width);
      expect(gap).toBeGreaterThanOrEqual(expected - 2.5);
      expect(gap).toBeLessThanOrEqual(expected + 2.5);
    }
    const rightEdge = Math.max(...sorted.map((box) => box.x + box.width));
    expect(rightEdge).toBeGreaterThanOrEqual(containerWidth - 3);
  }
}

async function layoutAt(h: DesktopHarness, width: number): Promise<Box[]> {
  h.setWidth(width);
  h.window.dispatchEvent(new h.window.Event('resize'));
  await flushFrames(h.window);
  return readBoxes(h);
}

describe('mosaic layout invariants (F06)', () => {
  it('places the real manifest coherently across a width sweep', async () => {
    const { photos, sequence } = readRealManifest();
    const h = await loadDesktopGallery({ photos, sequence, width: 320 });
    const heroId = h.window.document
      .getElementById('galleryHeroOpen')!
      .getAttribute('data-entry-id') as string;
    const expectedIds = (photos as Array<{ id: string }>)
      .map((photo) => photo.id)
      .filter((id) => id !== heroId);
    expect(expectedIds.length).toBe(28);

    for (const width of [320, 375, 414, 559, 560, 561, 768, 849, 899, 900, 901, 1024, 1280, 1440, 1920]) {
      const boxes = await layoutAt(h, width);
      assertPlacement(boxes, width, expectedIds);
      if (width >= 900) assertGutters(boxes, width);
    }

    // Oscillating widths must return to identical geometry (no stale drift).
    const first900 = await layoutAt(h, 900);
    await layoutAt(h, 560);
    await layoutAt(h, 1440);
    const backTo900 = await layoutAt(h, 900);
    const fingerprint = (boxes: Box[]) =>
      boxes
        .map((box) => `${box.id}:${box.x},${box.y},${box.width},${box.mediaHeight}`)
        .sort()
        .join('|');
    expect(fingerprint(backTo900)).toBe(fingerprint(first900));

    h.dom.window.close();
  });

  it('falls back to readable full-width rows when two panoramas defeat the DP', async () => {
    const photos = [makePhoto('p0', 1.5), makePhoto('p1', 3), makePhoto('p2', 3)];
    const h = await loadDesktopGallery({ photos, width: 900 });
    const boxes = readBoxes(h);

    // Pre-fix the solver returned null and the archive stayed empty.
    expect(boxes.map((box) => box.id).sort()).toEqual(['p1', 'p2']);
    assertPlacement(boxes, 900, ['p1', 'p2']);
    for (const box of boxes) {
      expect(box.width).toBeCloseTo(900, -1);
      expect(box.mediaHeight).toBeCloseTo(300, -1);
    }
    h.dom.window.close();
  });

  it('keeps panorama-only sets finite, full width, and stacked', async () => {
    const photos = [
      makePhoto('p0', 1.5),
      makePhoto('p1', 2.4),
      makePhoto('p2', 3),
      makePhoto('p3', 6)
    ];
    const h = await loadDesktopGallery({ photos, width: 900 });
    const boxes = readBoxes(h);

    assertPlacement(boxes, 900, ['p1', 'p2', 'p3']);
    const byId = new Map(boxes.map((box) => [box.id, box]));
    expect(byId.get('p1')!.mediaHeight).toBeCloseTo(900 / 2.4, -1);
    expect(byId.get('p2')!.mediaHeight).toBeCloseTo(300, -1);
    expect(byId.get('p3')!.mediaHeight).toBeCloseTo(150, -1);
    h.dom.window.close();
  });

  it('keeps portrait-only sets full-bleed with consistent gutters', async () => {
    const photos = [
      makePhoto('p0', 1.5),
      makePhoto('p1', 0.6),
      makePhoto('p2', 0.75),
      makePhoto('p3', 0.5)
    ];
    const h = await loadDesktopGallery({ photos, width: 900 });
    const boxes = readBoxes(h);

    assertPlacement(boxes, 900, ['p1', 'p2', 'p3']);
    // The solver may justify one row or use a spanning course; either way it
    // must stay full-bleed with consistent gutters (not the pre-fix 881px).
    assertGutters(boxes, 900);
    const rightEdge = Math.max(...boxes.map((box) => box.x + box.width));
    expect(rightEdge).toBeGreaterThanOrEqual(897);
    h.dom.window.close();
  });

  it('holds invariants for mixed aspect sets around the 560/900 breakpoints', async () => {
    const aspects = [3, 0.6, 2.5, 0.75, 1.6, 3, 0.66, 1.2, 2.8, 0.5, 1.8, 2.2];
    const photos = [makePhoto('p0', 1.5), ...aspects.map((aspect, i) => makePhoto(`a${i}`, aspect))];
    const h = await loadDesktopGallery({ photos, width: 900 });
    const expectedIds = aspects.map((_, i) => `a${i}`);

    for (const width of [560, 561, 899, 900, 901]) {
      const boxes = await layoutAt(h, width);
      assertPlacement(boxes, width, expectedIds);
    }
    h.dom.window.close();
  });

  it('re-solves when loaded image aspects disagree with manifest data', async () => {
    const photos = Array.from({ length: 7 }, (_, i) => makePhoto(`p${i}`, 1.5));
    const h = await loadDesktopGallery({ photos, width: 900 });
    const before = readBoxes(h);

    const cards = [...h.grid.querySelectorAll<HTMLElement>('.photo-card')];
    cards.forEach((card, index) => {
      const image = card.querySelector('img') as HTMLImageElement;
      const natural = index % 2 === 0 ? { w: 800, h: 1000 } : { w: 2500, h: 1000 };
      Object.defineProperty(image, 'naturalWidth', { value: natural.w, configurable: true });
      Object.defineProperty(image, 'naturalHeight', { value: natural.h, configurable: true });
      image.dispatchEvent(new h.window.Event('load'));
    });
    await flushFrames(h.window, 6);

    const expectedIds = photos.slice(1).map((photo) => photo.id as string);
    const after = readBoxes(h);
    assertPlacement(after, 900, expectedIds);

    const aspectById = new Map(
      cards.map((card) => [
        card.dataset.entryId,
        card.querySelector<HTMLElement>('.photo-media')!.style.aspectRatio
      ])
    );
    expect(aspectById.get(before[0].id)).toBe('0.8000 / 1');
    expect(aspectById.get(before[1].id)).toBe('2.5000 / 1');
    expect(after.map((box) => `${box.id}:${box.mediaHeight}`).join()).not.toBe(
      before.map((box) => `${box.id}:${box.mediaHeight}`).join()
    );
    h.dom.window.close();
  });

  it('handles zero, one, and two manifest photos without error states', async () => {
    const zero = await loadDesktopGallery({ photos: [], width: 900 });
    const zeroDoc = zero.window.document;
    expect(zeroDoc.getElementById('galleryError')?.hidden).toBe(true);
    expect(zeroDoc.getElementById('galleryEmpty')?.hidden).toBe(false);
    expect(zeroDoc.getElementById('galleryArchiveSection')?.hidden).toBe(true);
    expect(readBoxes(zero)).toEqual([]);
    zero.dom.window.close();

    const one = await loadDesktopGallery({ photos: [makePhoto('solo', 1.5)], width: 900 });
    const oneDoc = one.window.document;
    expect(oneDoc.getElementById('galleryError')?.hidden).toBe(true);
    expect(oneDoc.getElementById('galleryEmpty')?.hidden).toBe(false);
    expect(readBoxes(one)).toEqual([]);
    one.dom.window.close();

    const two = await loadDesktopGallery(
      { photos: [makePhoto('p0', 1.5), makePhoto('p1', 2)], width: 900 },
    );
    const twoBoxes = readBoxes(two);
    assertPlacement(twoBoxes, 900, ['p1']);
    expect(twoBoxes[0].mediaHeight).toBeGreaterThan(0);
    two.dom.window.close();
  });
});
