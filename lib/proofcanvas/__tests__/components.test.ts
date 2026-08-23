import { SEMANTIC_COMPONENTS, insertSemanticComponent } from "../components";
import { createCantorDemoProject } from "../demo";
import { applyOperations } from "../operations";
import { ProjectDocumentSchema } from "../schema";

describe("editable semantic components", () => {
  test("inserts all six definitions as ordinary grouped objects with stable unique IDs", () => {
    const shotId = "shot-cantor-conclusion";
    let project = createCantorDemoProject();
    const originalIds = new Set(project.shots.flatMap((shot) => shot.objects.map(({ id }) => id)));

    for (const [index, component] of SEMANTIC_COMPONENTS.entries()) {
      project = insertSemanticComponent(project, shotId, component.id, { x: 220 + index * 80, y: 160 + index * 45 });
    }

    expect(SEMANTIC_COMPONENTS).toHaveLength(6);
    expect(ProjectDocumentSchema.safeParse(project).success).toBe(true);
    const allIds = project.shots.flatMap((shot) => shot.objects.map(({ id }) => id));
    expect(new Set(allIds).size).toBe(allIds.length);
    for (const id of originalIds) expect(allIds).toContain(id);

    const shot = project.shots.find(({ id }) => id === shotId)!;
    for (const component of SEMANTIC_COMPONENTS) {
      const group = shot.objects.find(({ type, name }) => type === "group" && name === component.name);
      expect(group).toBeDefined();
      expect(shot.objects.filter(({ parentId }) => parentId === group!.id).length).toBeGreaterThanOrEqual(2);
    }

    const editableChild = shot.objects.find(({ parentId }) => parentId && !originalIds.has(parentId))!;
    const edited = applyOperations(project, shotId, [{ type: "update-object", objectId: editableChild.id, patch: { name: "Edited component child" } }]).project;
    expect(edited.shots.find(({ id }) => id === shotId)!.objects.find(({ id }) => id === editableChild.id)?.name).toBe("Edited component child");
  });
});
