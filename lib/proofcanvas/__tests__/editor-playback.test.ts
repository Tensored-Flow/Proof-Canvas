import { EditorPlaybackClock, EditorSequencePlaybackClock } from "../editorPlayback";

describe("isolated editor playback clock", () => {
  test("publishes finite changed values without owning project state", () => {
    const clock = new EditorPlaybackClock(1);
    const listener = jest.fn();
    const unsubscribe = clock.subscribe(listener);
    clock.publish(1);
    clock.publish(1.25);
    clock.publish(Number.NaN);
    expect(clock.getSnapshot()).toBe(1.25);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    clock.publish(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("publishes coherent project-global snapshots as one external-store value", () => {
    const initial = { globalTime: 1, shotId: "shot-a", localTime: 1, atFinalEndpoint: false } as const;
    const clock = new EditorSequencePlaybackClock(initial);
    const listener = jest.fn();
    clock.subscribe(listener);

    clock.publish({ ...initial });
    clock.publish({ globalTime: 2, shotId: "shot-b", localTime: 0, atFinalEndpoint: false });
    clock.publish({ globalTime: Number.NaN, shotId: "shot-b", localTime: 0, atFinalEndpoint: false });

    expect(clock.getSnapshot()).toEqual({ globalTime: 2, shotId: "shot-b", localTime: 0, atFinalEndpoint: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
