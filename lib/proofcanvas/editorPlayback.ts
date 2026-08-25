export class EditorPlaybackClock {
  private value: number;
  private readonly listeners = new Set<() => void>();

  constructor(initialValue = 0) {
    this.value = initialValue;
  }

  getSnapshot = (): number => this.value;

  getServerSnapshot = (): number => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  publish(value: number): void {
    if (!Number.isFinite(value) || value === this.value) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}

export type EditorSequencePlaybackSnapshot = Readonly<{
  globalTime: number;
  shotId: string;
  localTime: number;
  atFinalEndpoint: boolean;
}>;

function sameSequenceSnapshot(
  left: EditorSequencePlaybackSnapshot,
  right: EditorSequencePlaybackSnapshot,
): boolean {
  return left.globalTime === right.globalTime
    && left.shotId === right.shotId
    && left.localTime === right.localTime
    && left.atFinalEndpoint === right.atFinalEndpoint;
}

/**
 * High-frequency project playback authority for isolated React subscribers.
 * The editor publishes one coherent global/shot/local snapshot so consumers
 * never reconstruct different boundary ownership from independent numbers.
 */
export class EditorSequencePlaybackClock {
  private value: EditorSequencePlaybackSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(initialValue: EditorSequencePlaybackSnapshot) {
    this.value = initialValue;
  }

  getSnapshot = (): EditorSequencePlaybackSnapshot => this.value;

  getServerSnapshot = (): EditorSequencePlaybackSnapshot => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  publish(value: EditorSequencePlaybackSnapshot): void {
    if (
      !Number.isFinite(value.globalTime)
      || !Number.isFinite(value.localTime)
      || !value.shotId
      || sameSequenceSnapshot(this.value, value)
    ) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}
