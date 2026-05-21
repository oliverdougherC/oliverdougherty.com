export function copyArrayBuffer(buffer: ArrayBufferLike): ArrayBuffer {
  if (buffer instanceof ArrayBuffer) {
    return buffer.slice(0);
  }

  const bytes = new Uint8Array(buffer);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function arrayBufferLikeToArrayBuffer(buffer: ArrayBufferLike): ArrayBuffer {
  return buffer instanceof ArrayBuffer ? buffer : copyArrayBuffer(buffer);
}

export function sliceArrayBufferView(view: ArrayBufferView<ArrayBufferLike>): ArrayBuffer {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
