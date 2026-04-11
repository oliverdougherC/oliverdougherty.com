import { buildGeneratedAudioPreset, GENERATED_AUDIO_PRESETS } from '@utilities/audioPresets';

describe('generated audio presets', () => {
  it('creates deterministic non-silent bounded presets', () => {
    for (const presetId of Object.keys(GENERATED_AUDIO_PRESETS) as Array<keyof typeof GENERATED_AUDIO_PRESETS>) {
      const first = buildGeneratedAudioPreset(presetId, 2, 8000);
      const second = buildGeneratedAudioPreset(presetId, 2, 8000);
      const samples = first.channels[0];
      const peak = Math.max(...Array.from(samples).map(Math.abs));
      const energy = Array.from(samples).reduce((sum, value) => sum + value * value, 0);

      expect(samples.length).toBe(16_000);
      expect(Array.from(samples.slice(0, 128))).toEqual(Array.from(second.channels[0].slice(0, 128)));
      expect(peak).toBeLessThanOrEqual(1);
      expect(energy).toBeGreaterThan(1);
    }
  });
});

