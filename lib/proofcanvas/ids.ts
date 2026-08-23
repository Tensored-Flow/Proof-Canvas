import type { ProjectDocument, Shot } from "./schema";

export type IdKind = "project" | "shot" | "object" | "animation" | "style" | "group";

export function collectProjectIds(project: ProjectDocument): Set<string> {
  const ids = new Set<string>([project.metadata.id]);
  for (const style of project.styles) ids.add(style.id);
  for (const shot of project.shots) {
    ids.add(shot.id);
    for (const object of shot.objects) ids.add(object.id);
    for (const animation of shot.animations) ids.add(animation.id);
  }
  return ids;
}

export function collectShotIds(shot: Shot): Set<string> {
  return new Set([shot.id, ...shot.objects.map(({ id }) => id), ...shot.animations.map(({ id }) => id)]);
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || "item";
}

/** Deterministic allocation. The caller persists the returned ID with the entity. */
export function allocateId(prefix: IdKind | string, existingIds: ReadonlySet<string>, hint = "item"): string {
  const base = `${slug(prefix)}-${slug(hint)}`;
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function assertFreshId(id: string, existingIds: ReadonlySet<string>): void {
  if (existingIds.has(id)) throw new Error(`ID already exists: ${id}`);
}
