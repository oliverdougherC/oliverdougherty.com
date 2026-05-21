export async function deleteLocalModelCaches(cacheStorage = globalThis.caches, logLabel = 'Local assistant cache deletion failed.') {
  if (!cacheStorage?.keys || !cacheStorage?.delete) return false;

  try {
    const cacheNames = await cacheStorage.keys();
    const targets = cacheNames.filter((name) => /huggingface|transformers|local-llm|bonsai/i.test(name));
    await Promise.all(targets.map((name) => cacheStorage.delete(name)));
    return true;
  } catch (error) {
    console.debug(logLabel, error);
    return false;
  }
}
