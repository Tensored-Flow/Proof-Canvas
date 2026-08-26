import { cloneSerializable, type SceneObject } from "./schema";

/**
 * Remap only object references declared by a scene-object contract.
 *
 * The generic properties envelope may contain opaque IDs supplied by authors
 * or external systems, so field-name inference is intentionally forbidden.
 */
export function remapDeclaredObjectPropertyReferences(
  object: SceneObject,
  objectIdMapping: ReadonlyMap<string, string>,
): SceneObject["properties"] {
  const properties = cloneSerializable(object.properties);
  if (object.semanticRole === "annotation-arrow" && typeof properties.targetId === "string") {
    properties.targetId = objectIdMapping.get(properties.targetId) ?? properties.targetId;
  }
  return properties;
}
