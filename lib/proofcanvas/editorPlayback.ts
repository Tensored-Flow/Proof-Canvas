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
