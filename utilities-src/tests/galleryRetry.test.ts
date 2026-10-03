import { loadDesktopGallery, loadMobileGallery, makePhoto, sleep } from './galleryHarness';

for (const mobile of [false, true]) {
  describe(`${mobile ? 'mobile' : 'desktop'} viewer retry resource identity`, () => {
    async function fixture() {
      const photos = [makePhoto('p0', 1.5), makePhoto('p1', 1.5)];
      // Existing query parameters and fragments must survive a cache bypass.
      for (const photo of photos) {
        for (const name of ['medium', 'large'] as const) {
          const variant = photo[name];
          for (const format of ['jpg', 'avif', 'webp'] as const) variant[format] += '?quality=80#photo';
        }
      }
      const h = mobile
        ? await loadMobileGallery({ photos })
        : await loadDesktopGallery({ photos, width: 1200, manualImages: true });
      const doc = h.window.document;
      const prefix = mobile ? 'mobileLightbox' : 'lightbox';
      const pending = () => doc.querySelector<HTMLImageElement>(mobile
        ? '.mobile-lightbox-incoming img' : '.lightbox-picture.is-preparing img')!;
      const image = () => doc.getElementById(`${prefix}Image`) as HTMLImageElement;
      const click = (suffix: string) => (doc.getElementById(`${prefix}${suffix}`) as HTMLButtonElement).click();
      const key = (key: string) => doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true }));
      const open = () => (mobile
        ? h.grid.querySelector<HTMLButtonElement>('button')!
        : doc.querySelector<HTMLButtonElement>('.lightbox-thumb[data-entry-id="p0"]')!).click();
      const fail = () => pending().dispatchEvent(new h.window.Event('error'));
      const finish = async (target = pending()) => {
        Object.defineProperty(target, 'naturalWidth', { configurable: true, value: 1600 });
        target.decode = () => Promise.resolve();
        target.dispatchEvent(new h.window.Event('load'));
        await sleep(0);
      };
      const urls = () => {
        const target = pending();
        return [target.src, ...[target, ...target.closest('picture')!.querySelectorAll('source')]
          .flatMap(node => node.srcset.split(',').filter(Boolean).map(candidate => candidate.trim().split(' ')[0]))];
      };
      return { h, doc, pending, image, click, key, open, fail, finish, urls };
    }

    it('changes all responsive URLs on explicit retry while preserving their query and hash', async () => {
      const f = await fixture();
      try {
        f.open();
        const original = f.urls();
        expect(original.every(src => !src.includes('_gallery_retry'))).toBe(true);
        f.fail();
        f.click('Retry');
        const firstRetry = f.urls();
        const tokens = firstRetry.map(src => new URL(src, f.doc.baseURI).searchParams.get('_gallery_retry'));
        expect(tokens.every(token => Boolean(token))).toBe(true);
        expect(new Set(tokens).size).toBe(1);
        for (const src of firstRetry) {
          const url = new URL(src, f.doc.baseURI);
          expect(url.searchParams.get('quality')).toBe('80');
          expect(url.hash).toBe('#photo');
        }
        f.fail();
        f.click('Retry');
        expect(f.urls().every(src => new URL(src, f.doc.baseURI).searchParams.get('_gallery_retry') !== tokens[0])).toBe(true);
        await f.finish();
        expect(f.image().alt).toBe('Photo p0');
      } finally { f.h.dom.window.close(); }
    });

    it('retains the recovered identity through navigation and close/reopen without changing other entries', async () => {
      const f = await fixture();
      try {
        f.open();
        f.fail();
        f.click('Retry');
        const recovered = f.urls();
        await f.finish();
        f.key('ArrowRight');
        expect(f.urls().every(src => !src.includes('_gallery_retry'))).toBe(true);
        await f.finish();
        f.key('ArrowLeft');
        expect(f.urls()).toEqual(recovered);
        await f.finish();
        f.click('Close');
        f.open();
        expect(f.urls()).toEqual(recovered);
        await f.finish();
        expect(f.image().alt).toBe('Photo p0');
        expect([...f.h.grid.querySelectorAll('img')].every(image => !image.src.includes('_gallery_retry'))).toBe(true);
      } finally { f.h.dom.window.close(); }
    });
  });
}
