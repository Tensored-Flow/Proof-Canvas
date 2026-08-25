import { applyOperations, type ManualSceneOperation } from "./operations";
import { canonicalProjectJson, cloneProject, type ProjectDocument } from "./schema";
import { applyDocumentOperations, type DocumentOperation } from "./documentOperations";

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
    // History snapshots are immutable by contract: all authoring seams clone
    // before mutation. Preserve those references instead of re-cloning every
    // prior document on every edit (which made N edits quadratic in project
    // size and history depth).
    past: [...history.past, { label, project: history.present }],
    present: cloneProject(nextProject),
    future: [],
  };
}

export function commitOperations(
  history: ProjectHistory,
  shotId: string,
  operations: readonly ManualSceneOperation[],
  label: string,
): ProjectHistory {
  const result = applyOperations(history.present, shotId, operations);
  return commitProject(history, result.project, label);
}

export function commitDocumentOperations(
  history: ProjectHistory,
  operations: readonly DocumentOperation[],
  label: string,
): ProjectHistory {
  const result = applyDocumentOperations(history.present, operations);
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
    past: history.past.slice(0, -1),
    present: previous.project,
    future: [{ label: previous.label, project: history.present }, ...history.future],
  };
}

export function redo(history: ProjectHistory): ProjectHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, { label: next.label, project: history.present }],
    present: next.project,
    future: history.future.slice(1),
  };
}
