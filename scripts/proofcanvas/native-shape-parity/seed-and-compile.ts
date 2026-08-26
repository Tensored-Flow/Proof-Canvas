import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeProofCanvasDatabase, proofCanvasDatabase } from "../../../lib/proofcanvas/database.server";
import { compileManim } from "../../../lib/proofcanvas/compiler";
import { canonicalProjectJson } from "../../../lib/proofcanvas/schema";
import { SqliteProjectRepository } from "../../../lib/proofcanvas/repository.server";
import {
  NATIVE_SHAPE_PARITY_COLORS,
  NATIVE_SHAPE_PARITY_PROJECT_ID,
  createNativeShapeParityProject,
} from "./project";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function main() {
  const outputDirectory = path.resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("Usage: seed-and-compile.ts OUTPUT_DIRECTORY");
  await mkdir(outputDirectory, { recursive: true });

  const fixedNow = new Date("2026-08-25T12:00:00.000Z");
  const repository = new SqliteProjectRepository(proofCanvasDatabase(), {
    now: () => fixedNow,
    randomId: (prefix) => prefix === "project"
      ? NATIVE_SHAPE_PARITY_PROJECT_ID
      : "checkpoint-4e4154495645534841504553",
  });
  try {
    const created = repository.createProject({
      kind: "blank",
      title: "Native shape parity",
      mutationId: "native-shape-parity-create",
    });
    if (created.replayed || created.value.projectId !== NATIVE_SHAPE_PARITY_PROJECT_ID) {
      throw new Error("Deterministic parity project creation did not produce the expected identity");
    }
    const base = repository.getProject(NATIVE_SHAPE_PARITY_PROJECT_ID);
    const authored = createNativeShapeParityProject(base.document);
    const saved = repository.saveProject({
      projectId: NATIVE_SHAPE_PARITY_PROJECT_ID,
      expectedRevision: base.revision,
      mutationId: "native-shape-parity-save-v4",
      document: authored,
    });
    if (saved.replayed || saved.value.revision !== 2) {
      throw new Error("Deterministic parity project save did not publish revision 2");
    }

    const durable = repository.getProject(NATIVE_SHAPE_PARITY_PROJECT_ID);
    const projectJson = canonicalProjectJson(durable.document);
    const compilation = compileManim(durable.document);
    if (compilation.diagnostics.some(({ severity }) => severity === "error")) {
      throw new Error(`Parity fixture compilation failed: ${JSON.stringify(compilation.diagnostics)}`);
    }
    const source = compilation.python;
    const projectPath = path.join(outputDirectory, "project.proofcanvas.json");
    const sourcePath = path.join(outputDirectory, "generated.py");
    await Promise.all([
      writeFile(projectPath, projectJson, { encoding: "utf8", mode: 0o600 }),
      writeFile(sourcePath, source, { encoding: "utf8", mode: 0o600 }),
      writeFile(path.join(outputDirectory, "compiler.json"), `${JSON.stringify({
        schemaVersion: durable.document.schemaVersion,
        projectId: durable.id,
        revision: durable.revision,
        projectSha256: sha256(projectJson),
        sourceSha256: sha256(source),
        compilerDeterministic: compileManim(durable.document).python === source,
        objectTypes: durable.document.shots[0].objects.map(({ type }) => type),
        colors: NATIVE_SHAPE_PARITY_COLORS,
        diagnostics: compilation.diagnostics,
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }),
    ]);
  } finally {
    closeProofCanvasDatabase();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
