export type EditorCommandId =
  | "toggle-playback"
  | "undo"
  | "redo"
  | "delete-selection"
  | "duplicate-selection"
  | "group-selection"
  | "ungroup-selection"
  | "open-command-palette"
  | "save-project"
  | "open-render-export"
  | "nudge-left"
  | "nudge-right"
  | "nudge-up"
  | "nudge-down"
  | "dismiss";

export type EditorCommandDefinition = Readonly<{
  id: EditorCommandId;
  label: string;
  shortcut: string;
  group: "Playback" | "Edit" | "Project" | "View";
}>;

export const EDITOR_COMMANDS: readonly EditorCommandDefinition[] = [
  { id: "toggle-playback", label: "Play or pause", shortcut: "Space", group: "Playback" },
  { id: "undo", label: "Undo", shortcut: "Mod Z", group: "Edit" },
  { id: "redo", label: "Redo", shortcut: "Mod Shift Z", group: "Edit" },
  { id: "delete-selection", label: "Delete selection", shortcut: "Delete", group: "Edit" },
  { id: "duplicate-selection", label: "Duplicate selection", shortcut: "Mod D", group: "Edit" },
  { id: "group-selection", label: "Group selection", shortcut: "Mod G", group: "Edit" },
  { id: "ungroup-selection", label: "Ungroup selection", shortcut: "Mod Shift G", group: "Edit" },
  { id: "open-command-palette", label: "Open command palette", shortcut: "Mod K", group: "Project" },
  { id: "save-project", label: "Save now", shortcut: "Mod S", group: "Project" },
  { id: "open-render-export", label: "Render or export", shortcut: "Mod Enter", group: "Project" },
  { id: "nudge-left", label: "Nudge left", shortcut: "Left arrow", group: "View" },
  { id: "nudge-right", label: "Nudge right", shortcut: "Right arrow", group: "View" },
  { id: "nudge-up", label: "Nudge up", shortcut: "Up arrow", group: "View" },
  { id: "nudge-down", label: "Nudge down", shortcut: "Down arrow", group: "View" },
  { id: "dismiss", label: "Close or clear context", shortcut: "Escape", group: "View" },
] as const;

export type EditorCommandInvocation = Readonly<{
  source: "keyboard" | "toolbar" | "menu" | "palette";
  event?: KeyboardEvent;
  shiftKey: boolean;
}>;

export type EditorCommandHandlers = Readonly<Partial<Record<EditorCommandId, (invocation: EditorCommandInvocation) => void>>>;

export function commandTargetWithin(target: EventTarget | null, selector: string): boolean {
  return typeof Element !== "undefined" && target instanceof Element && Boolean(target.closest(selector));
}

export function isEditableCommandTarget(target: EventTarget | null): boolean {
  return commandTargetWithin(target, 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
}

function isActivationTarget(target: EventTarget | null): boolean {
  return commandTargetWithin(target, 'button, a, summary, [role="button"], [role="menuitem"]');
}

export function commandForKeyboardEvent(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "target">): EditorCommandId | null {
  const key = event.key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;
  if (event.altKey) return null;
  if (event.key === "Escape") return "dismiss";
  // Project-level commands remain global so the browser never captures Save
  // Page while a title or inspector field has focus. Edit-level commands are
  // intentionally deferred to native field editing below.
  if (mod && key === "k") return "open-command-palette";
  if (mod && key === "s") return "save-project";
  if (mod && event.key === "Enter") return "open-render-export";
  if (isEditableCommandTarget(event.target)) return null;
  if (mod && key === "z") return event.shiftKey ? "redo" : "undo";
  if (mod && key === "y") return "redo";
  if (mod && key === "d") return "duplicate-selection";
  if (mod && key === "g") return event.shiftKey ? "ungroup-selection" : "group-selection";
  if (!mod && (event.key === "Delete" || event.key === "Backspace")) return "delete-selection";
  if (!mod && event.key === " " && !isActivationTarget(event.target)) return "toggle-playback";
  if (!mod && event.key === "ArrowLeft") return "nudge-left";
  if (!mod && event.key === "ArrowRight") return "nudge-right";
  if (!mod && event.key === "ArrowUp") return "nudge-up";
  if (!mod && event.key === "ArrowDown") return "nudge-down";
  return null;
}

export function createEditorCommandController(
  handlers: EditorCommandHandlers,
  enabled: (id: EditorCommandId, invocation: EditorCommandInvocation) => boolean = () => true,
) {
  const execute = (id: EditorCommandId, invocation: EditorCommandInvocation = { source: "toolbar", shiftKey: false }): boolean => {
    const handler = handlers[id];
    if (!handler || !enabled(id, invocation)) return false;
    handler(invocation);
    return true;
  };
  const handleKeyboard = (event: KeyboardEvent): EditorCommandId | null => {
    if (event.defaultPrevented) return null;
    const id = commandForKeyboardEvent(event);
    if (!id) return null;
    const invocation = { source: "keyboard", event, shiftKey: event.shiftKey } as const;
    if (!handlers[id] || !enabled(id, invocation)) return null;
    event.preventDefault();
    handlers[id]!(invocation);
    return id;
  };
  return { execute, handleKeyboard } as const;
}
