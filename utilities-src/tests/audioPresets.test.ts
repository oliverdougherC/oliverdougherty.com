import {
  AUDIO_FOURIER_PRESETS,
  BUILT_IN_AUDIO_PRESETS,
  DEFAULT_BUILT_IN_AUDIO_PRESET_ID,
  getAudioFourierPreset,
  isAudioFourierPresetId,
  type BuiltInAudioPresetId
} from '@utilities/audioPresets';

describe('built-in audio presets', () => {
  it('maps the default Fourier sources to bundled song files', () => {
    expect(DEFAULT_BUILT_IN_AUDIO_PRESET_ID).toBe('best-friends');
    expect(Object.keys(BUILT_IN_AUDIO_PRESETS)).toEqual([
      'best-friends',
      'i-cant-wait-to-get-there',
      'tell-your-friends'
    ]);

    const expectedFiles: Record<BuiltInAudioPresetId, string> = {
      'best-friends': 'Best Friends.flac',
      'i-cant-wait-to-get-there': "I Can't Wait To Get There.flac",
      'tell-your-friends': 'Tell Your Friends.flac'
    };

    for (const [presetId, filename] of Object.entries(expectedFiles) as Array<[BuiltInAudioPresetId, string]>) {
      const preset = BUILT_IN_AUDIO_PRESETS[presetId];
      expect(preset.label).toBeTruthy();
      expect(preset.url).toBe(`../../assets/utilities/fourier-decompose/${filename}`);
    }
  });

  it('guards Fourier preset ids before lookup', () => {
    expect(isAudioFourierPresetId('fast')).toBe(true);
    expect(isAudioFourierPresetId('balanced')).toBe(true);
    expect(isAudioFourierPresetId('detailed')).toBe(true);
    expect(isAudioFourierPresetId('unknown')).toBe(false);
    expect(getAudioFourierPreset('balanced')).toBe(AUDIO_FOURIER_PRESETS.balanced);
    expect(() => getAudioFourierPreset('unknown')).toThrow('Unknown audio Fourier preset: unknown');
  });
});
