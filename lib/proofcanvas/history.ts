import { applyOperations } from "./operations";
import { canonicalProjectJson, cloneProject, type ProjectDocument, type SceneOperation } from "./schema";

export interface HistoryEntry {
  label: string;
  project: ProjectDocument;
}

export interface ProjectHistory {
  past: HistoryEntry[];
  present: ProjectDocument;
  future: HistoryEntry[];
}

export function createHistory(project: ProjectDocument): ProjectHistory {
  return { past: [], present: cloneProject(project), future: [] };
}

export function commitProject(history: ProjectHistory, nextProject: ProjectDocument, label: string): ProjectHistory {
  if (!label.trim()) throw new Error("History transaction requires a label");
  if (canonicalProjectJson(history.present) === canonicalProjectJson(nextProject)) return history;
  return {
    past: [...history.past.map((entry) => ({ ...entry, project: cloneProject(entry.project) })), { label, project: cloneProject(history.present) }],
    present: cloneProject(nextProject),
    future: [],
  };
}

export function commitOperations(
  history: ProjectHistory,
  shotId: string,
  operations: readonly SceneOperation[],
  label: string,
): ProjectHistory {
  const result = applyOperations(history.present, shotId, operations);
  return commitProject(history, result.project, label);
}

export function canUndo(history: ProjectHistory): boolean {
  return history.past.length > 0;
}

export function canRedo(history: ProjectHistory): boolean {
  return history.future.length > 0;
}

export function undo(history: ProjectHistory): ProjectHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1).map((entry) => ({ ...entry, project: cloneProject(entry.project) })),
    present: cloneProject(previous.project),
    future: [{ label: previous.label, project: cloneProject(history.present) }, ...history.future.map((entry) => ({ ...entry, project: cloneProject(entry.project) }))],
  };
}

export function redo(history: ProjectHistory): ProjectHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past.map((entry) => ({ ...entry, project: cloneProject(entry.project) })), { label: next.label, project: cloneProject(history.present) }],
    present: cloneProject(next.project),
    future: history.future.slice(1).map((entry) => ({ ...entry, project: cloneProject(entry.project) })),
  };
}
