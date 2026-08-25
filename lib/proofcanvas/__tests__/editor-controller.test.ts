import { commandForKeyboardEvent, createEditorCommandController, EDITOR_COMMANDS } from "../editorCommands";
import { animationSelection, keyframeSelection, normalizeEditorSelection, objectSelection, selectedAnimationIds, selectedObjectIds, shotSelection } from "../editorSelection";
import { createCantorDemoProject } from "../demo";
import { commitOperations, createHistory, redo, undo } from "../history";

function keyboard(key: string, options: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
}

describe("editor selection and command controller", () => {
  test("keeps one normalized shot-scoped selection kind", () => {
    const project = createCantorDemoProject();
    const shot = project.shots[0];
    const objects = objectSelection(shot, [shot.objects[0].id, shot.objects[0].id, shot.objects[1].id]);
    expect(objects).toMatchObject({ kind: "objects", objectIds: [shot.objects[0].id, shot.objects[1].id], primaryObjectId: shot.objects[1].id });
    expect(selectedObjectIds(objects, shot.id)).toHaveLength(2);
    expect(selectedAnimationIds(objects, shot.id)).toEqual([]);

    const animation = animationSelection(shot, [shot.animations[0].id]);
    expect(selectedAnimationIds(animation, shot.id)).toEqual([shot.animations[0].id]);
    expect(selectedObjectIds(animation, shot.id)).toEqual([]);
    expect(normalizeEditorSelection(animation, project, project.shots[1].id)).toEqual(shotSelection([project.shots[1].id]));
  });

  test("reserves keyframe selection and removes stale references", () => {
    const project = createCantorDemoProject();
    const shot = project.shots[0];
    shot.propertyTracks = [{
      id: "track-test-x",
      target: { kind: "object", objectId: shot.objects[0].id },
      property: "x",
      keyframes: [{ id: "keyframe-test-x", time: 0, value: 100, interpolation: { kind: "linear" } }],
    }];
    const track = shot.propertyTracks[0];
    const selection = keyframeSelection(shot, [
      { trackId: track.id, keyframeId: track.keyframes[0].id },
      { trackId: "missing-track", keyframeId: "missing-keyframe" },
    ]);
    expect(selection).toMatchObject({ kind: "keyframes", keyframes: [{ trackId: track.id, keyframeId: track.keyframes[0].id }] });
  });

  test("normalizes hierarchy roots and keeps the declared primary authoritative", () => {
    const project = createCantorDemoProject();
    const shot = project.shots[0];
    const ancestor = "object-interval-diagram";
    const child = "object-interval-generation-0";
    const rooted = objectSelection(shot, [ancestor, child], child);
    expect(rooted).toMatchObject({ kind: "objects", objectIds: [ancestor], primaryObjectId: ancestor });

    const first = shot.objects[0].id;
    const second = shot.objects[1].id;
    const explicitObjectPrimary = objectSelection(shot, [first, second], first);
    expect(explicitObjectPrimary).toMatchObject({ kind: "objects", objectIds: [second, first], primaryObjectId: first });

    const firstAnimation = shot.animations[0].id;
    const secondAnimation = shot.animations[1].id;
    const explicitAnimationPrimary = animationSelection(shot, [firstAnimation, secondAnimation], firstAnimation);
    expect(explicitAnimationPrimary).toMatchObject({ kind: "animation", animationIds: [secondAnimation, firstAnimation], primaryAnimationId: firstAnimation });
  });

  test("repairs deleted primaries across undo, redo, and shot switches", () => {
    const project = createCantorDemoProject();
    const shot = project.shots[0];
    const first = "object-title";
    const second = "object-subtitle";
    const selection = objectSelection(shot, [first, second], first);
    const committed = commitOperations(createHistory(project), shot.id, [{ type: "delete-object", objectId: first }], "Delete primary");

    expect(normalizeEditorSelection(selection, committed.present, shot.id)).toMatchObject({ kind: "objects", objectIds: [second], primaryObjectId: second });
    const undone = undo(committed);
    expect(normalizeEditorSelection(selection, undone.present, shot.id)).toEqual(selection);
    const redone = redo(undone);
    expect(normalizeEditorSelection(selection, redone.present, shot.id)).toMatchObject({ kind: "objects", objectIds: [second], primaryObjectId: second });
    expect(normalizeEditorSelection(selection, redone.present, project.shots[1].id)).toEqual(shotSelection([project.shots[1].id]));
  });

  test("maps the documented shortcuts and suppresses editable descendants", () => {
    const input = document.createElement("input");
    const textbox = document.createElement("div");
    textbox.setAttribute("role", "textbox");
    const textboxChild = document.createElement("span");
    textbox.append(textboxChild);
    expect(commandForKeyboardEvent({ key: "k", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: document.body })).toBe("open-command-palette");
    expect(commandForKeyboardEvent({ key: "Enter", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false, target: document.body })).toBe("open-render-export");
    expect(commandForKeyboardEvent({ key: "z", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, target: document.body })).toBe("redo");
    expect(commandForKeyboardEvent({ key: "Delete", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: input })).toBeNull();
    expect(commandForKeyboardEvent({ key: " ", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: textboxChild })).toBeNull();
    expect(commandForKeyboardEvent({ key: "s", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: input })).toBe("save-project");
    expect(commandForKeyboardEvent({ key: "k", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: input })).toBe("open-command-palette");
    expect(commandForKeyboardEvent({ key: "Enter", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: input })).toBe("open-render-export");
    expect(commandForKeyboardEvent({ key: "k", ctrlKey: true, metaKey: false, shiftKey: false, altKey: true, target: document.body })).toBeNull();
    expect(EDITOR_COMMANDS.map(({ shortcut }) => shortcut)).toEqual(expect.arrayContaining(["Space", "Mod K", "Mod S", "Mod Enter"]));
  });

  test("executes one registered handler and respects enablement", () => {
    const undo = jest.fn();
    const save = jest.fn();
    const controller = createEditorCommandController({ undo, "save-project": save }, (id) => id !== "save-project");
    const undoEvent = keyboard("z", { ctrlKey: true });
    document.body.dispatchEvent(undoEvent);
    expect(controller.handleKeyboard(undoEvent)).toBe("undo");
    expect(undo).toHaveBeenCalledTimes(1);
    const saveEvent = keyboard("s", { ctrlKey: true });
    expect(controller.handleKeyboard(saveEvent)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});
