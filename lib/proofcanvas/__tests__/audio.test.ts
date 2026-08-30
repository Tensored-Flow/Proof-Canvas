import {
  PROOFCANVAS_WAVEFORM_LIMITS,
  activeAudioPlayback,
  audioClipGainAt,
  audioClipIsActive,
  audioSourceTimeAt,
  summarizeDecodedWaveform,
} from "../audio";
import type { AudioClip, Shot } from "../schema";

const clip: AudioClip = {
  id: "audio-playback-main",
  assetId: "asset-playback-main",
  name: "Main",
  start: 2,
  duration: 4,
  sourceStart: 10,
  sourceEnd: 18,
  volume: 2,
  muted: false,
  solo: false,
  fadeIn: 1,
  fadeOut: 2,
};

function shot(audioClips: AudioClip[] = [clip]): Pick<Shot, "audioClips" | "propertyTracks"> {
  return { audioClips, propertyTracks: [] };
}

test("maps the active half-open clip interval to its exact source range", () => {
  expect(audioClipIsActive(clip, 1.999)).toBe(false);
  expect(audioClipIsActive(clip, 2)).toBe(true);
  expect(audioClipIsActive(clip, 5.999)).toBe(true);
  expect(audioClipIsActive(clip, 6)).toBe(false);
  expect(audioSourceTimeAt(clip, 2)).toBe(10);
  expect(audioSourceTimeAt(clip, 4)).toBe(14);
  expect(audioSourceTimeAt(clip, 5)).toBe(16);
});

test("combines base volume, fades, mute, solo, and volume keyframes deterministically", () => {
  expect(audioClipGainAt(shot(), clip, 2)).toBe(0);
  expect(audioClipGainAt(shot(), clip, 2.5)).toBe(1);
  expect(audioClipGainAt(shot(), clip, 4)).toBe(2);
  expect(audioClipGainAt(shot(), clip, 5)).toBe(1);
  expect(audioClipGainAt(shot(), { ...clip, muted: true }, 4)).toBe(0);

  const ordinary = { ...clip, id: "audio-playback-ordinary" };
  const solo = { ...clip, id: "audio-playback-solo", solo: true };
  expect(audioClipGainAt(shot([ordinary, solo]), ordinary, 4)).toBe(0);
  expect(audioClipGainAt(shot([ordinary, solo]), solo, 4)).toBe(2);

  const keyframed = shot();
  keyframed.propertyTracks.push({
    id: "track-playback-volume",
    target: { kind: "audio", audioClipId: clip.id },
    property: "volume",
    keyframes: [
      { id: "keyframe-playback-a", time: 3, value: 0.5, interpolation: { kind: "linear" } },
      { id: "keyframe-playback-b", time: 5, value: 1.5, interpolation: { kind: "linear" } },
    ],
  });
  expect(audioClipGainAt(keyframed, clip, 2.5)).toBe(1);
  expect(audioClipGainAt(keyframed, clip, 3)).toBe(0.5);
  expect(audioClipGainAt(keyframed, clip, 4)).toBe(1);
  expect(audioClipGainAt(keyframed, clip, 5)).toBe(0.75);
});

test("returns stable active playback records sorted by clip ID", () => {
  const second = { ...clip, id: "audio-playback-a", assetId: "asset-playback-a", volume: 1 };
  expect(activeAudioPlayback(shot([clip, second]), 4).map(({ clipId, sourceTime, gain }) => ({ clipId, sourceTime, gain }))).toEqual([
    { clipId: "audio-playback-a", sourceTime: 14, gain: 1 },
    { clipId: "audio-playback-main", sourceTime: 14, gain: 2 },
  ]);
});

test("summarizes decoded multichannel PCM into deterministic bounded peaks", () => {
  const result = summarizeDecodedWaveform([
    new Float32Array([-1, -0.5, 0.25, 1]),
    new Float32Array([0.5, -0.25, 0.75, 0]),
  ], 2);
  expect(result).toHaveLength(2);
  expect(result[0]).toEqual({ minimum: -1, maximum: 0.5, rms: Math.sqrt((1 + 0.25 + 0.25 + 0.0625) / 4) });
  expect(result[1]).toEqual({ minimum: 0, maximum: 1, rms: Math.sqrt((0.0625 + 0.5625 + 1) / 4) });
});

test("bounds waveform shape/work and rejects invalid decoded samples", () => {
  expect(Object.isFrozen(PROOFCANVAS_WAVEFORM_LIMITS)).toBe(true);
  expect(() => summarizeDecodedWaveform([], 10)).toThrow(/channel count/);
  expect(() => summarizeDecodedWaveform([new Float32Array(1)], 0)).toThrow(/bucket count/);
  expect(() => summarizeDecodedWaveform([new Float32Array(1)], PROOFCANVAS_WAVEFORM_LIMITS.maxBuckets + 1)).toThrow(/bucket count/);
  expect(() => summarizeDecodedWaveform([new Float32Array(1), new Float32Array(2)], 1)).toThrow(/equal lengths/);
  expect(() => summarizeDecodedWaveform([new Float32Array([Number.NaN])], 1)).toThrow(/finite PCM/);

  const huge = new Float32Array(PROOFCANVAS_WAVEFORM_LIMITS.maxSamplesInspected + 100_000);
  huge[0] = -1;
  huge[huge.length - 1] = 1;
  expect(summarizeDecodedWaveform([huge], 100)).toHaveLength(100);
});
