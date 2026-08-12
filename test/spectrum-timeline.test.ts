import { describe, expect, test } from "bun:test";
import {
  SPECTRUM_BANDS,
  SPECTRUM_FFT_SIZE,
  SpectrumTimelineCache,
  analyzeSpectrumTimeline,
  createSpectrumLookup,
  fftMagnitudes,
  spectrumBandBins,
  type SpectrumLookup,
} from "../web/src/lib/spectrum-timeline.ts";

describe("offline spectrum timeline", () => {
  test("places a known sine wave at its FFT bin", () => {
    const targetBin = 37;
    const samples = Float32Array.from({ length: SPECTRUM_FFT_SIZE }, (_, index) =>
      Math.sin(2 * Math.PI * targetBin * index / SPECTRUM_FFT_SIZE)
    );
    const magnitudes = fftMagnitudes(samples);
    const peakBin = magnitudes.reduce(
      (peak, value, index) => value > magnitudes[peak]! ? index : peak,
      0,
    );
    expect(peakBin).toBe(targetBin);
    expect(magnitudes[targetBin]).toBeGreaterThan(500);
  });

  test("splits 60Hz to 14kHz into seventeen logarithmic bands", () => {
    const bands = spectrumBandBins(48_000);
    expect(bands).toHaveLength(SPECTRUM_BANDS);
    expect(bands[0]!.lowHz).toBeCloseTo(60, 6);
    expect(bands.at(-1)!.highHz).toBeCloseTo(14_000, 6);
    const ratios = bands.map((band) => band.highHz / band.lowHz);
    for (const ratio of ratios) expect(ratio).toBeCloseTo(ratios[0]!, 10);
    for (const [index, band] of bands.entries()) {
      expect(band.startBin).toBeGreaterThanOrEqual(1);
      expect(band.endBin).toBeGreaterThan(band.startBin);
      expect(band.endBin).toBeLessThanOrEqual(SPECTRUM_FFT_SIZE / 2);
      if (index > 0) expect(band.lowHz).toBeCloseTo(bands[index - 1]!.highHz, 8);
    }
  });

  test("interpolates adjacent 80ms timeline slots", () => {
    const levels = new Uint8Array(SPECTRUM_BANDS * 2);
    levels[0] = 0;
    levels[SPECTRUM_BANDS] = 255;
    levels[3] = 64;
    levels[SPECTRUM_BANDS + 3] = 128;
    const lookup = createSpectrumLookup({
      hopMs: 80,
      bandCount: SPECTRUM_BANDS,
      frameCount: 2,
      levels,
    });
    expect(lookup(0, 0)).toBe(0);
    expect(lookup(40, 0)).toBeCloseTo(0.5, 6);
    expect(lookup(80, 0)).toBe(1);
    expect(lookup(40, 3)).toBeCloseTo(96 / 255, 6);
    expect(lookup(8_000, 0)).toBe(1);
    expect(lookup(0, -1)).toBeUndefined();
    expect(lookup(0, SPECTRUM_BANDS)).toBeUndefined();
  });

  test("keeps a decaying peak after a short tone", () => {
    const sampleRate = 48_000;
    const hopSamples = Math.round(sampleRate * 0.08);
    const samples = new Float32Array(SPECTRUM_FFT_SIZE + hopSamples);
    const frequency = 1_000;
    for (let index = 0; index < SPECTRUM_FFT_SIZE; index += 1) {
      samples[index] = Math.sin(2 * Math.PI * frequency * index / sampleRate);
    }
    const timeline = analyzeSpectrumTimeline(samples, sampleRate);
    expect(timeline.frameCount).toBe(2);
    const bands = spectrumBandBins(sampleRate);
    const toneBand = bands.findIndex((band) => frequency >= band.lowHz && frequency < band.highHz);
    const first = timeline.levels[toneBand]!;
    const held = timeline.levels[SPECTRUM_BANDS + toneBand]!;
    expect(first).toBeGreaterThan(200);
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(first);
  });

  test("keeps only the three most recently used tracks", async () => {
    const loads: string[] = [];
    const lookup: SpectrumLookup = () => 0.5;
    const cache = new SpectrumTimelineCache(async (trackId) => {
      loads.push(trackId);
      return lookup;
    });
    await cache.get("a");
    await cache.get("b");
    await cache.get("c");
    await cache.get("a");
    await cache.get("d");
    await cache.get("b");
    expect(loads).toEqual(["a", "b", "c", "d", "b"]);
  });

  test("wires one lookup into preview and mirror with an 80ms signature slot", async () => {
    const [player, preview] = await Promise.all([
      Bun.file(new URL("../web/src/components/music/music-player.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/music/pixel-lyrics-preview.tsx", import.meta.url)).text(),
    ]);
    expect(player).toContain("spectrum={activeSpectrum}");
    expect(player).toMatch(/renderMirrorFrames\(\{[\s\S]*?spectrum: activeSpectrum,[\s\S]*?\}\)/);
    expect(preview).toContain("Math.floor(smoothTimeMs / SPECTRUM_HOP_MS)");
  });

  // 真 FFT 只在「网页自己就是播放器、且这块 52×16 只归预览管」时才取。两个排除项
  // 是同一条规则的两半：deviceOnline 是侧载歌词固件的心跳，zos 是时钟上跑着 ZOS
  // —— 两套固件画的都是 LyricModes.h 那套确定性伪频谱，谁也不做 FFT。漏掉 zos，
  // 用户就会在预览里看到真频谱、在面板上看到 hash 频谱，下面还挂着一句「此音源为
  // 模拟律动」；而主题正是照着预览挑的。
  test("a ZOS device falls through to the deterministic bars its firmware draws", async () => {
    const player = await Bun.file(
      new URL("../web/src/components/music/music-player.tsx", import.meta.url),
    ).text();
    const guard = player.match(/if \(!trackId \|\| activeProviderId !== "netease"[^\n]*\) return;/);
    expect(guard?.[0]).toContain("zos");
    const derived = player.match(/const activeSpectrum = [\s\S]*?: undefined;/);
    expect(derived?.[0]).toContain("!zos");
    // 而这颗芯片说的是实话：simulatedSpectrum 只负责那句文案，它切换不了任何东西。
    expect(player).toContain("simulatedSpectrum={remoteMode || deviceOnline || zos}");
  });
});
