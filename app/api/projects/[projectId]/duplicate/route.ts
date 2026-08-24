import { z } from "zod";
import { authorizeStateChangingRequest } from "@/lib/proofcanvas/auth.server";
import { jsonNoStore, readJsonRequest, routeFailure } from "@/lib/proofcanvas/http.server";
import { projectRepository } from "@/lib/proofcanvas/repository.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const Schema = z.object({
  expectedRevision: z.number().int().positive(),
  mutationId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  title: z.string().trim().min(1).max(160).optional(),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    authorizeStateChangingRequest(request);
    const { projectId } = await context.params;
    const input = Schema.parse(await readJsonRequest(request, 8 * 1_024));
    const result = projectRepository().duplicateProject({ projectId, ...input });
    return jsonNoStore({ ok: true, project: result.value, replayed: result.replayed }, 201);
  } catch (error) {
    return routeFailure(error);
  }
}
