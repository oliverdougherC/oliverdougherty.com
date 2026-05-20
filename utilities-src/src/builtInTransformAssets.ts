import { TRANSFORM_DEMO_ASSET_URLS } from './uiState';

function createCacheKey(presetId: string, sourceUrl: string, targetUrl: string) {
  return `${presetId}\u001f${sourceUrl}\u001f${targetUrl}`;
}

export const PRECOMPUTED_BUILT_IN_TRANSFORM_ASSETS: Record<string, string> = {
  [createCacheKey('balanced', TRANSFORM_DEMO_ASSET_URLS.pattern, TRANSFORM_DEMO_ASSET_URLS.face)]: new URL(
    './data/precomputed-transforms/pattern-face-balanced.json',
    import.meta.url
  ).href,
  [createCacheKey('balanced', TRANSFORM_DEMO_ASSET_URLS.pattern, TRANSFORM_DEMO_ASSET_URLS.lucki)]: new URL(
    './data/precomputed-transforms/source-target-balanced.json',
    import.meta.url
  ).href,
  [createCacheKey('balanced', TRANSFORM_DEMO_ASSET_URLS.pattern, TRANSFORM_DEMO_ASSET_URLS.keef)]: new URL(
    './data/precomputed-transforms/face-pattern-balanced.json',
    import.meta.url
  ).href
};
