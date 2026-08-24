import { z } from "zod";
import { authorizeStateChangingRequest } from "@/lib/proofcanvas/auth.server";
import { jsonNoStore, readJsonRequest, routeFailure } from "@/lib/proofcanvas/http.server";
import { projectRepository } from "@/lib/proofcanvas/repository.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const Schema = z.object({
  checkpointId: z.string().regex(/^checkpoint-[a-f0-9]{24}$/),
  expectedRevision: z.number().int().positive(),
  mutationId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    authorizeStateChangingRequest(request);
    const { projectId } = await context.params;
    const input = Schema.parse(await readJsonRequest(request, 8 * 1_024));
    const result = projectRepository().recoverCheckpoint({ projectId, ...input });
    return jsonNoStore({ ok: true, recovery: result.value, replayed: result.replayed });
  } catch (error) {
    return routeFailure(error);
  }
}
