import { EditorPlaybackClock } from "../editorPlayback";

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
});
