export interface ComplexSpectrum {
  real: Float32Array;
  imag: Float32Array;
}

function assertPowerOfTwo(size: number) {
  if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
    throw new Error('FFT size must be a power of two.');
  }
}

function reverseBits(value: number, bits: number) {
  let reversed = 0;
  for (let index = 0; index < bits; index += 1) {
    reversed = (reversed << 1) | (value & 1);
    value >>= 1;
  }
  return reversed;
}

export function fft(inputReal: Float32Array, inputImag?: Float32Array, inverse = false): ComplexSpectrum {
  assertPowerOfTwo(inputReal.length);
  if (inputImag && inputImag.length !== inputReal.length) {
    throw new Error('FFT real and imaginary buffers must have matching lengths.');
  }

  const size = inputReal.length;
  const bits = Math.log2(size);
  const real = new Float32Array(size);
  const imag = new Float32Array(size);

  for (let index = 0; index < size; index += 1) {
    const reversedIndex = reverseBits(index, bits);
    real[reversedIndex] = inputReal[index];
    imag[reversedIndex] = inputImag?.[index] ?? 0;
  }

  for (let blockSize = 2; blockSize <= size; blockSize <<= 1) {
    const halfBlockSize = blockSize >> 1;
    const angleStep = (inverse ? 2 : -2) * Math.PI / blockSize;
    const stepReal = Math.cos(angleStep);
    const stepImag = Math.sin(angleStep);

    for (let blockStart = 0; blockStart < size; blockStart += blockSize) {
      let rotationReal = 1;
      let rotationImag = 0;

      for (let offset = 0; offset < halfBlockSize; offset += 1) {
        const left = blockStart + offset;
        const right = left + halfBlockSize;
        const rightReal = real[right] * rotationReal - imag[right] * rotationImag;
        const rightImag = real[right] * rotationImag + imag[right] * rotationReal;

        real[right] = real[left] - rightReal;
        imag[right] = imag[left] - rightImag;
        real[left] += rightReal;
        imag[left] += rightImag;

        const nextRotationReal = rotationReal * stepReal - rotationImag * stepImag;
        rotationImag = rotationReal * stepImag + rotationImag * stepReal;
        rotationReal = nextRotationReal;
      }
    }
  }

  if (inverse) {
    for (let index = 0; index < size; index += 1) {
      real[index] /= size;
      imag[index] /= size;
    }
  }

  return { real, imag };
}

