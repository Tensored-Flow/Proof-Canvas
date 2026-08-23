import { TextDecoder } from "node:util";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  ProofCanvasProviderOutputError,
  proofCanvasOpenAiConfiguration,
  proposeWithOpenAi,
} from "@/lib/proofcanvas/openaiProvider";
import { ProjectDocumentSchema, type SceneOperation } from "@/lib/proofcanvas/schema";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const MAX_BODY_BYTES = 192 * 1024;
const IdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/i).max(96);
const RequestSchema = z.object({
  project: ProjectDocumentSchema,
  shotId: IdSchema,
  selectedObjectIds: z.array(IdSchema).max(64),
  instruction: z.string().trim().min(1).max(1_000),
}).strict().superRefine((value, context) => {
  const shot = value.project.shots.find(({ id }) => id === value.shotId);
  if (!shot) {
    context.addIssue({ code: "custom", path: ["shotId"], message: "Shot does not exist" });
    return;
  }
  if (new Set(value.selectedObjectIds).size !== value.selectedObjectIds.length) {
    context.addIssue({ code: "custom", path: ["selectedObjectIds"], message: "Selection contains duplicate IDs" });
  }
  const objectIds = new Set(shot.objects.map(({ id }) => id));
  value.selectedObjectIds.forEach((id, index) => {
    if (!objectIds.has(id)) context.addIssue({ code: "custom", path: ["selectedObjectIds", index], message: "Selected object does not exist in the shot" });
  });
});

export interface ProofCanvasAiSuccessResponse {
  ok: true;
  provider: "configured-provider";
  demoMode: false;
  intention: string;
  summary: string[];
  operations: SceneOperation[];
}

export interface ProofCanvasAiErrorResponse {
  ok: false;
  code: "invalid_request" | "provider_unavailable" | "invalid_provider_output" | "provider_error";
  message: string;
}

function json(body: ProofCanvasAiSuccessResponse | ProofCanvasAiErrorResponse, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function errorResponse(status: number, code: ProofCanvasAiErrorResponse["code"], message: string) {
  return json({ ok: false, code, message }, status);
}

function declaredBodyTooLarge(request: Request): boolean {
  const header = request.headers.get("content-length");
  if (header === null) return false;
  const length = Number(header);
  return !Number.isSafeInteger(length) || length < 0 || length > MAX_BODY_BYTES;
}

class BodyTooLargeError extends Error {}

async function readBoundedBody(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export async function POST(request: Request) {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return errorResponse(415, "invalid_request", "Content-Type must be application/json");
  }
  if (declaredBodyTooLarge(request)) {
    return errorResponse(413, "invalid_request", "Request body exceeds the ProofCanvas AI limit");
  }

  // Do not spend validation work on a route that cannot service the request.
  const configuration = proofCanvasOpenAiConfiguration();
  if (!configuration) {
    return errorResponse(
      503,
      "provider_unavailable",
      "OpenAI editing is not configured; use the labelled deterministic demo interpreter.",
    );
  }

  let raw: string;
  try {
    raw = await readBoundedBody(request);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return errorResponse(413, "invalid_request", "Request body exceeds the ProofCanvas AI limit");
    }
    return errorResponse(400, "invalid_request", "Request body could not be read");
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return errorResponse(400, "invalid_request", "Request body must contain valid JSON");
  }
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Request body does not match the ProofCanvas AI schema");
  }

  try {
    const proposal = await proposeWithOpenAi(parsed.data, configuration);
    return json({ ok: true, ...proposal });
  } catch (error) {
    if (error instanceof ProofCanvasProviderOutputError || error instanceof z.ZodError) {
      return errorResponse(422, "invalid_provider_output", "The provider response did not pass ProofCanvas operation validation");
    }
    return errorResponse(502, "provider_error", "The configured AI provider could not complete the request");
  }
}
