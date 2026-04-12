import {
  BUILT_IN_AUDIO_PRESETS,
  DEFAULT_BUILT_IN_AUDIO_PRESET_ID,
  buildGeneratedAudioPresetChannels,
  type BuiltInAudioPresetId
} from '@utilities/audioPresets';

function maxAbs(samples: Float32Array) {
  let max = 0;
  for (const sample of samples) {
    max = Math.max(max, Math.abs(sample));
  }
  return max;
}

describe('built-in audio presets', () => {
  it('maps the default Fourier sources to generated signals', () => {
    expect(DEFAULT_BUILT_IN_AUDIO_PRESET_ID).toBe('harmonic-chord');
    expect(Object.keys(BUILT_IN_AUDIO_PRESETS)).toEqual([
      'harmonic-chord',
      'bass-pulse',
      'bell-sweep',
      'vowel-stack'
    ]);

    for (const presetId of Object.keys(BUILT_IN_AUDIO_PRESETS) as BuiltInAudioPresetId[]) {
      const preset = BUILT_IN_AUDIO_PRESETS[presetId];
      const generated = buildGeneratedAudioPresetChannels(presetId);
      expect(preset.label).toBeTruthy();
      expect(generated.sampleRate).toBe(preset.sampleRate);
      expect(generated.channels).toHaveLength(2);
      expect(generated.channels[0].length).toBe(Math.round(preset.sampleRate * preset.durationSeconds));
      expect(maxAbs(generated.channels[0])).toBeGreaterThan(0.05);
    }
  });
});
