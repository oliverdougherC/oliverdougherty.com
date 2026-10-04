/** Explicitly bypass application storage and the runtime's OPFS model manager. */
export async function downloadModel(url: string, expectedBytes: number, signal: AbortSignal,
  progress: (loaded: number, total: number | null, phase: string) => void): Promise<Blob> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
  if (!response.ok) throw new Error(`Model download failed (${response.status}). Please retry.`);
  if (!response.body) throw new Error('This browser cannot stream the model download.');
  const contentLength = Number(response.headers.get('content-length'));
  const total = contentLength > 0 ? contentLength : expectedBytes;
  const header = new Uint8Array(8);
  let headerBytes = 0;
  let loaded = 0;
  let lastProgress = 0;
  // Let the browser stream into its Blob implementation. Retaining thousands of
  // ArrayBuffers and constructing a second multi-GB Blob causes large peak memory
  // and platform-dependent backing-file failures. This transform keeps only 8 bytes.
  const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      signal.throwIfAborted();
      loaded += chunk.byteLength;
      if (loaded > expectedBytes) throw new Error('Model transfer size did not match its pinned release.');
      const take = Math.min(chunk.byteLength, 8 - headerBytes);
      if (take) { header.set(chunk.subarray(0, take), headerBytes); headerBytes += take; }
      if (performance.now() - lastProgress > 80) {
        progress(loaded, total, 'Downloading model');
        lastProgress = performance.now();
      }
      controller.enqueue(chunk);
    },
  }), { signal });
  const blob = await new Response(counted, { headers: { 'Content-Type': 'application/octet-stream' } }).blob();
  signal.throwIfAborted();
  if (loaded !== expectedBytes || blob.size !== expectedBytes) throw new Error('The model download was interrupted. Please retry.');
  if (String.fromCharCode(...header.slice(0, 4)) !== 'GGUF' || new DataView(header.buffer).getUint32(4, true) !== 3) {
    throw new Error('The model format is unsupported. Expected GGUF version 3.');
  }
  progress(loaded, total, 'Initializing WebGPU');
  return blob;
}
