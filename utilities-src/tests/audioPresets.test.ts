import {
  BUILT_IN_AUDIO_PRESETS,
  DEFAULT_BUILT_IN_AUDIO_PRESET_ID,
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
});
