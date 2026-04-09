function createCacheKey(presetId: string, sourceUrl: string, targetUrl: string) {
  return `${presetId}::${sourceUrl}::${targetUrl}`;
}

const PATTERN_URL = '../../assets/utilities/pattern.png';
const FACE_URL = '../../assets/utilities/face.png';
const LUCKI_URL = '../../assets/utilities/lucki.jpeg';
const KEEF_URL = '../../assets/utilities/keef.jpeg';

export const PRECOMPUTED_BUILT_IN_TRANSFORM_ASSETS: Record<string, string> = {
  [createCacheKey('balanced', PATTERN_URL, FACE_URL)]: new URL(
    './data/precomputed-transforms/pattern-face-balanced.json',
    import.meta.url
  ).href,
  [createCacheKey('balanced', PATTERN_URL, LUCKI_URL)]: new URL(
    './data/precomputed-transforms/source-target-balanced.json',
    import.meta.url
  ).href,
  [createCacheKey('balanced', PATTERN_URL, KEEF_URL)]: new URL(
    './data/precomputed-transforms/face-pattern-balanced.json',
    import.meta.url
  ).href
};
