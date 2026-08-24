import { z } from "zod";
import { authenticateRequest, authorizeStateChangingRequest } from "@/lib/proofcanvas/auth.server";
import { jsonNoStore, readJsonRequest, routeFailure } from "@/lib/proofcanvas/http.server";
import { PROOFCANVAS_PROJECT_MAX_BYTES, ProjectDocumentSchema } from "@/lib/proofcanvas/schema";
import { ThumbnailMetadataSchema, projectRepository } from "@/lib/proofcanvas/repository.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const SaveSchema = z.object({
  expectedRevision: z.number().int().positive(),
  mutationId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  document: ProjectDocumentSchema,
  thumbnail: ThumbnailMetadataSchema.nullable().optional(),
}).strict();

const RenameSchema = z.object({
  expectedRevision: z.number().int().positive(),
  mutationId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  title: z.string().trim().min(1).max(160),
}).strict();

const DeleteSchema = z.object({
  expectedRevision: z.number().int().positive(),
  mutationId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
}).strict();

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    authenticateRequest(request);
    const { projectId } = await context.params;
    return jsonNoStore({ ok: true, project: projectRepository().getProject(projectId) });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    authorizeStateChangingRequest(request);
    const { projectId } = await context.params;
    const input = SaveSchema.parse(await readJsonRequest(request, PROOFCANVAS_PROJECT_MAX_BYTES + 64 * 1_024));
    const result = projectRepository().saveProject({ projectId, ...input });
    return jsonNoStore({ ok: true, project: result.value, replayed: result.replayed });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    authorizeStateChangingRequest(request);
    const { projectId } = await context.params;
    const input = RenameSchema.parse(await readJsonRequest(request, 8 * 1_024));
    const result = projectRepository().renameProject({ projectId, ...input });
    return jsonNoStore({ ok: true, project: result.value, replayed: result.replayed });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    authorizeStateChangingRequest(request);
    const { projectId } = await context.params;
    const input = DeleteSchema.parse(await readJsonRequest(request, 8 * 1_024));
    const result = projectRepository().deleteProject({ projectId, ...input });
    return jsonNoStore({ ok: true, project: result.value, replayed: result.replayed });
  } catch (error) {
    return routeFailure(error);
  }
}
