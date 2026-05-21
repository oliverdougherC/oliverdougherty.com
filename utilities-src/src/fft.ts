import { assertPowerOfTwo } from './math';

export interface ComplexSpectrum {
  real: Float32Array;
  imag: Float32Array;
}

export interface FftWorkspace {
  real: Float32Array;
  imag: Float32Array;
  twiddleCache: Map<number, {
    forwardReal: Float32Array;
    forwardImag: Float32Array;
    inverseReal: Float32Array;
    inverseImag: Float32Array;
  }>;
}

function reverseBits(value: number, bits: number) {
  let reversed = 0;
  for (let index = 0; index < bits; index += 1) {
    reversed = (reversed << 1) | (value & 1);
    value >>= 1;
  }
  return reversed;
}

export function createFftWorkspace(size: number): FftWorkspace {
  assertPowerOfTwo(size);
  return {
    real: new Float32Array(size),
    imag: new Float32Array(size),
    twiddleCache: new Map()
  };
}

function getTwiddleFactors(workspace: FftWorkspace, blockSize: number) {
  let factors = workspace.twiddleCache.get(blockSize);
  if (!factors) {
    const halfBlockSize = blockSize >> 1;
    factors = {
      forwardReal: new Float32Array(halfBlockSize),
      forwardImag: new Float32Array(halfBlockSize),
      inverseReal: new Float32Array(halfBlockSize),
      inverseImag: new Float32Array(halfBlockSize)
    };
    for (let offset = 0; offset < halfBlockSize; offset += 1) {
      const angle = -2 * Math.PI * offset / blockSize;
      factors.forwardReal[offset] = Math.cos(angle);
      factors.forwardImag[offset] = Math.sin(angle);
      factors.inverseReal[offset] = factors.forwardReal[offset];
      factors.inverseImag[offset] = -factors.forwardImag[offset];
    }
    workspace.twiddleCache.set(blockSize, factors);
  }
  return factors;
}

export function fftInto(
  inputReal: Float32Array,
  inputImag: Float32Array | undefined,
  inverse: boolean,
  workspace: FftWorkspace
): ComplexSpectrum {
  assertPowerOfTwo(inputReal.length);
  if (inputImag && inputImag.length !== inputReal.length) {
    throw new Error('FFT real and imaginary buffers must have matching lengths.');
  }

  const size = inputReal.length;
  if (workspace.real.length !== size || workspace.imag.length !== size) {
    throw new Error('FFT workspace buffers must match the input size.');
  }

  const bits = Math.log2(size);
  const { real, imag } = workspace;
  real.fill(0);
  imag.fill(0);

  for (let index = 0; index < size; index += 1) {
    const reversedIndex = reverseBits(index, bits);
    real[reversedIndex] = inputReal[index];
    imag[reversedIndex] = inputImag?.[index] ?? 0;
  }

  for (let blockSize = 2; blockSize <= size; blockSize <<= 1) {
    const halfBlockSize = blockSize >> 1;
    const twiddles = getTwiddleFactors(workspace, blockSize);
    const rotationRealByOffset = inverse ? twiddles.inverseReal : twiddles.forwardReal;
    const rotationImagByOffset = inverse ? twiddles.inverseImag : twiddles.forwardImag;

    for (let blockStart = 0; blockStart < size; blockStart += blockSize) {
      for (let offset = 0; offset < halfBlockSize; offset += 1) {
        const rotationReal = rotationRealByOffset[offset];
        const rotationImag = rotationImagByOffset[offset];
        const left = blockStart + offset;
        const right = left + halfBlockSize;
        const rightReal = real[right] * rotationReal - imag[right] * rotationImag;
        const rightImag = real[right] * rotationImag + imag[right] * rotationReal;

        real[right] = real[left] - rightReal;
        imag[right] = imag[left] - rightImag;
        real[left] += rightReal;
        imag[left] += rightImag;
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

export function fft(inputReal: Float32Array, inputImag?: Float32Array, inverse = false): ComplexSpectrum {
  const workspace = createFftWorkspace(inputReal.length);
  const spectrum = fftInto(inputReal, inputImag, inverse, workspace);
  return {
    real: new Float32Array(spectrum.real),
    imag: new Float32Array(spectrum.imag)
  };
}
