export const SPECTRUM_FFT_SIZE = 1024;
export const SPECTRUM_HOP_MS = 80;
export const SPECTRUM_BANDS = 17;
export const SPECTRUM_MIN_HZ = 60;
export const SPECTRUM_MAX_HZ = 14_000;

export interface SpectrumBandBins {
  startBin: number;
  endBin: number;
  lowHz: number;
  highHz: number;
}

export interface SpectrumTimeline {
  hopMs: number;
  bandCount: number;
  frameCount: number;
  levels: Uint8Array;
}

export type SpectrumLookup = (timeMs: number, bar: number) => number | undefined;

function isPowerOfTwo(value: number): boolean {
  return value > 1 && (value & (value - 1)) === 0;
}

/** Radix-2 FFT magnitudes for real-valued samples. */
export function fftMagnitudes(samples: Float32Array): Float64Array {
  const size = samples.length;
  if (!isPowerOfTwo(size)) throw new Error("FFT input length must be a power of two");
  const real = Float64Array.from(samples);
  const imaginary = new Float64Array(size);

  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index >= reversed) continue;
    [real[index], real[reversed]] = [real[reversed]!, real[index]!];
    [imaginary[index], imaginary[reversed]] = [imaginary[reversed]!, imaginary[index]!];
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const baseReal = Math.cos(angle);
    const baseImaginary = Math.sin(angle);
    for (let offset = 0; offset < size; offset += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let index = 0; index < length / 2; index += 1) {
        const even = offset + index;
        const odd = even + length / 2;
        const oddReal = real[odd]! * twiddleReal - imaginary[odd]! * twiddleImaginary;
        const oddImaginary = real[odd]! * twiddleImaginary + imaginary[odd]! * twiddleReal;
        real[odd] = real[even]! - oddReal;
        imaginary[odd] = imaginary[even]! - oddImaginary;
        real[even] = real[even]! + oddReal;
        imaginary[even] = imaginary[even]! + oddImaginary;
        const nextTwiddleReal = twiddleReal * baseReal - twiddleImaginary * baseImaginary;
        twiddleImaginary = twiddleReal * baseImaginary + twiddleImaginary * baseReal;
        twiddleReal = nextTwiddleReal;
      }
    }
  }

  const magnitudes = new Float64Array(size / 2);
  for (let index = 0; index < magnitudes.length; index += 1) {
    magnitudes[index] = Math.hypot(real[index]!, imaginary[index]!);
  }
  return magnitudes;
}

export function spectrumBandBins(
  sampleRate: number,
  fftSize = SPECTRUM_FFT_SIZE,
  bandCount = SPECTRUM_BANDS,
): SpectrumBandBins[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !isPowerOfTwo(fftSize)) {
    throw new Error("sample rate and FFT size must be valid");
  }
  const nyquist = sampleRate / 2;
  const maximum = Math.min(SPECTRUM_MAX_HZ, nyquist);
  const minimum = Math.min(SPECTRUM_MIN_HZ, maximum / 2);
  const ratio = maximum / minimum;
  const finalBin = fftSize / 2;
  return Array.from({ length: bandCount }, (_, index) => {
    const lowHz = minimum * ratio ** (index / bandCount);
    const highHz = minimum * ratio ** ((index + 1) / bandCount);
    const startBin = Math.max(1, Math.min(finalBin - 1, Math.floor(lowHz * fftSize / sampleRate)));
    const endBin = Math.max(
      startBin + 1,
      Math.min(finalBin, Math.ceil(highHz * fftSize / sampleRate)),
    );
    return { startBin, endBin, lowHz, highHz };
  });
}

function hann(index: number, size: number): number {
  return 0.5 * (1 - Math.cos(2 * Math.PI * index / (size - 1)));
}

export function analyzeSpectrumTimeline(
  monoSamples: Float32Array,
  sampleRate: number,
): SpectrumTimeline {
  const hopSamples = Math.max(1, Math.round(sampleRate * SPECTRUM_HOP_MS / 1_000));
  const frameCount = Math.max(
    1,
    Math.floor(Math.max(0, monoSamples.length - SPECTRUM_FFT_SIZE) / hopSamples) + 1,
  );
  const bands = spectrumBandBins(sampleRate);
  const levels = new Uint8Array(frameCount * SPECTRUM_BANDS);
  const windowed = new Float32Array(SPECTRUM_FFT_SIZE);
  const rollingPeak = new Float64Array(SPECTRUM_BANDS);
  const heldPeak = new Float64Array(SPECTRUM_BANDS);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sampleOffset = frame * hopSamples;
    for (let index = 0; index < SPECTRUM_FFT_SIZE; index += 1) {
      windowed[index] = (monoSamples[sampleOffset + index] ?? 0) * hann(index, SPECTRUM_FFT_SIZE);
    }
    const magnitudes = fftMagnitudes(windowed);
    for (let bar = 0; bar < bands.length; bar += 1) {
      const band = bands[bar]!;
      let energySquared = 0;
      for (let bin = band.startBin; bin < band.endBin; bin += 1) {
        energySquared += magnitudes[bin]! ** 2;
      }
      const energy = Math.sqrt(energySquared / Math.max(1, band.endBin - band.startBin));
      rollingPeak[bar] = Math.max(energy, rollingPeak[bar]! * 0.985, 1e-9);
      const normalized = energy < 1e-7 ? 0 : Math.min(1, energy / rollingPeak[bar]!);
      heldPeak[bar] = normalized >= heldPeak[bar]!
        ? normalized
        : Math.max(normalized, heldPeak[bar]! - 0.045);
      const withPeakHold = Math.max(normalized, heldPeak[bar]! * 0.88);
      levels[frame * SPECTRUM_BANDS + bar] = Math.round(withPeakHold * 255);
    }
  }

  return {
    hopMs: SPECTRUM_HOP_MS,
    bandCount: SPECTRUM_BANDS,
    frameCount,
    levels,
  };
}

export function createSpectrumLookup(timeline: SpectrumTimeline): SpectrumLookup {
  return (timeMs, bar) => {
    if (!Number.isFinite(timeMs) || !Number.isInteger(bar) || bar < 0 || bar >= timeline.bandCount) {
      return undefined;
    }
    if (timeline.frameCount < 1 || timeline.levels.length < timeline.bandCount) return undefined;
    const position = Math.max(0, timeMs) / timeline.hopMs;
    const lowerFrame = Math.min(timeline.frameCount - 1, Math.floor(position));
    const upperFrame = Math.min(timeline.frameCount - 1, lowerFrame + 1);
    const fraction = Math.min(1, Math.max(0, position - lowerFrame));
    const lower = timeline.levels[lowerFrame * timeline.bandCount + bar]!;
    const upper = timeline.levels[upperFrame * timeline.bandCount + bar]!;
    return (lower + (upper - lower) * fraction) / 255;
  };
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index += 1) {
      mono[index] += samples[index]! / buffer.numberOfChannels;
    }
  }
  return mono;
}

function analyzeWhenIdle(samples: Float32Array, sampleRate: number): Promise<SpectrumTimeline> {
  return new Promise((resolve, reject) => {
    const analyze = () => {
      try {
        resolve(analyzeSpectrumTimeline(samples, sampleRate));
      } catch (error) {
        reject(error);
      }
    };
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(analyze, { timeout: 2_000 });
    } else {
      window.setTimeout(analyze, 0);
    }
  });
}

async function loadSpectrum(trackId: string): Promise<SpectrumLookup | null> {
  const response = await fetch(`/api/music/tracks/${encodeURIComponent(trackId)}/stream`, {
    cache: "force-cache",
  });
  if (!response.ok) throw new Error("audio stream is unavailable for spectrum analysis");
  const context = new AudioContext();
  let samples: Float32Array;
  let sampleRate: number;
  try {
    const audio = await context.decodeAudioData(await response.arrayBuffer());
    samples = mixToMono(audio);
    sampleRate = audio.sampleRate;
  } finally {
    await context.close().catch(() => undefined);
  }
  return createSpectrumLookup(await analyzeWhenIdle(samples!, sampleRate!));
}

export class SpectrumTimelineCache {
  private readonly entries = new Map<string, Promise<SpectrumLookup | null>>();

  constructor(
    private readonly loader: (trackId: string) => Promise<SpectrumLookup | null> = loadSpectrum,
    private readonly capacity = 3,
  ) {}

  get(trackId: string): Promise<SpectrumLookup | null> {
    const cached = this.entries.get(trackId);
    if (cached) {
      this.entries.delete(trackId);
      this.entries.set(trackId, cached);
      return cached;
    }

    const loading = this.loader(trackId).catch(() => null);
    this.entries.set(trackId, loading);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    void loading.then((value) => {
      if (value === null && this.entries.get(trackId) === loading) this.entries.delete(trackId);
    });
    return loading;
  }
}

const spectrumCache = new SpectrumTimelineCache();

/** Failures resolve to null so callers keep the deterministic pseudo-spectrum. */
export function spectrumForTrack(trackId: string): Promise<SpectrumLookup | null> {
  return spectrumCache.get(trackId);
}
