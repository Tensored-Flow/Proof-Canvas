import { z } from "zod";
import { authenticateRequest, authorizeStateChangingRequest } from "@/lib/proofcanvas/auth.server";
import { jsonNoStore, readJsonRequest, routeFailure } from "@/lib/proofcanvas/http.server";
import { projectRepository } from "@/lib/proofcanvas/repository.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const CreateSchema = z.object({
  kind: z.enum(["blank", "sample"]),
  title: z.string().trim().min(1).max(160),
  mutationId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
}).strict();

export async function GET(request: Request) {
  try {
    authenticateRequest(request);
    return jsonNoStore({ ok: true, projects: projectRepository().listProjects() });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function POST(request: Request) {
  try {
    authorizeStateChangingRequest(request);
    const input = CreateSchema.parse(await readJsonRequest(request, 8 * 1_024));
    const result = projectRepository().createProject(input);
    return jsonNoStore({ ok: true, project: result.value, replayed: result.replayed }, 201);
  } catch (error) {
    return routeFailure(error);
  }
}
