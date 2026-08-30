import { compareTimelineTimes, subtractTimelineTimes } from "./frame";
import type { AudioClip, PropertyTrack, Shot } from "./schema";
import { samplePropertyTrack } from "./timeline";

export const PROOFCANVAS_WAVEFORM_LIMITS = Object.freeze({
  maxChannels: 8,
  maxBuckets: 4_096,
  maxSamplesInspected: 2_000_000,
});

export interface AudioPlaybackState {
  clipId: string;
  assetId: string;
  sourceTime: number;
  gain: number;
}

export interface WaveformBucket {
  minimum: number;
  maximum: number;
  rms: number;
}

function volumeTrackFor(shot: Pick<Shot, "propertyTracks">, clipId: string): PropertyTrack | undefined {
  return shot.propertyTracks.find((track) => (
    track.target.kind === "audio"
    && track.target.audioClipId === clipId
    && track.property === "volume"
  ));
}

export function audioClipIsActive(clip: AudioClip, playhead: number): boolean {
  if (!Number.isFinite(playhead)) return false;
  const end = clip.start + clip.duration;
  return compareTimelineTimes(playhead, clip.start) >= 0 && compareTimelineTimes(playhead, end) < 0;
}

export function audioSourceTimeAt(clip: AudioClip, playhead: number): number {
  if (!audioClipIsActive(clip, playhead)) return clip.sourceStart;
  const progress = subtractTimelineTimes(playhead, clip.start) / clip.duration;
  return clip.sourceStart + (clip.sourceEnd - clip.sourceStart) * progress;
}

export function audioClipGainAt(shot: Pick<Shot, "audioClips" | "propertyTracks">, clip: AudioClip, playhead: number): number {
  if (!audioClipIsActive(clip, playhead) || clip.muted) return 0;
  const hasSolo = shot.audioClips.some(({ solo, muted }) => solo && !muted);
  if (hasSolo && !clip.solo) return 0;

  const localTime = subtractTimelineTimes(playhead, clip.start);
  const remaining = clip.duration - localTime;
  const fadeIn = clip.fadeIn ?? 0;
  const fadeOut = clip.fadeOut ?? 0;
  const envelope = Math.min(
    1,
    fadeIn > 0 ? localTime / fadeIn : 1,
    fadeOut > 0 ? remaining / fadeOut : 1,
  );
  const track = volumeTrackFor(shot, clip.id);
  const tracked = track && compareTimelineTimes(playhead, track.keyframes[0].time) >= 0
    ? samplePropertyTrack(track, playhead)
    : clip.volume;
  const volume = typeof tracked === "number" && Number.isFinite(tracked) ? tracked : clip.volume;
  return Math.max(0, Math.min(4, volume)) * Math.max(0, Math.min(1, envelope));
}

/** Exact active source positions and gains for one shot-local playhead. */
export function activeAudioPlayback(
  shot: Pick<Shot, "audioClips" | "propertyTracks">,
  playhead: number,
): AudioPlaybackState[] {
  return shot.audioClips
    .filter((clip) => audioClipIsActive(clip, playhead))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((clip) => ({
      clipId: clip.id,
      assetId: clip.assetId,
      sourceTime: audioSourceTimeAt(clip, playhead),
      gain: audioClipGainAt(shot, clip, playhead),
    }));
}

/**
 * Derive bounded display peaks from browser-decoded PCM. This is deliberately
 * a visual summary, never a replacement for the exact retained audio bytes.
 */
export function summarizeDecodedWaveform(
  channels: readonly Float32Array[],
  requestedBuckets: number,
): WaveformBucket[] {
  if (!Number.isSafeInteger(requestedBuckets) || requestedBuckets < 1 || requestedBuckets > PROOFCANVAS_WAVEFORM_LIMITS.maxBuckets) {
    throw new Error(`Waveform bucket count must be between 1 and ${PROOFCANVAS_WAVEFORM_LIMITS.maxBuckets}`);
  }
  if (channels.length < 1 || channels.length > PROOFCANVAS_WAVEFORM_LIMITS.maxChannels) {
    throw new Error(`Waveform channel count must be between 1 and ${PROOFCANVAS_WAVEFORM_LIMITS.maxChannels}`);
  }
  const frameCount = channels[0].length;
  if (frameCount < 1 || channels.some((channel) => channel.length !== frameCount)) {
    throw new Error("Waveform channels must be non-empty and have equal lengths");
  }
  const workPerBucket = Math.max(1, Math.floor(PROOFCANVAS_WAVEFORM_LIMITS.maxSamplesInspected / (requestedBuckets * channels.length)));
  return Array.from({ length: requestedBuckets }, (_, bucketIndex) => {
    const start = Math.floor(bucketIndex * frameCount / requestedBuckets);
    const end = Math.max(start + 1, Math.floor((bucketIndex + 1) * frameCount / requestedBuckets));
    const span = end - start;
    const stride = Math.max(1, Math.ceil(span / workPerBucket));
    let minimum = 1;
    let maximum = -1;
    let squareSum = 0;
    let samples = 0;
    for (let frame = start; frame < end; frame += stride) {
      for (const channel of channels) {
        const value = channel[frame];
        if (!Number.isFinite(value)) throw new Error("Waveform samples must be finite PCM values");
        const bounded = Math.max(-1, Math.min(1, value));
        minimum = Math.min(minimum, bounded);
        maximum = Math.max(maximum, bounded);
        squareSum += bounded * bounded;
        samples += 1;
      }
    }
    return {
      minimum: samples ? minimum : 0,
      maximum: samples ? maximum : 0,
      rms: samples ? Math.sqrt(squareSum / samples) : 0,
    };
  });
}
