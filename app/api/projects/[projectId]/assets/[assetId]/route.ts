import { z } from "zod";
import { authenticateRequest, authorizeStateChangingRequest } from "@/lib/proofcanvas/auth.server";
import { sanitizeAssetFilename } from "@/lib/proofcanvas/assetContent.server";
import { NO_STORE_HEADERS, jsonNoStore, readJsonRequest, routeFailure } from "@/lib/proofcanvas/http.server";
import { projectRepository } from "@/lib/proofcanvas/repository.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const DeleteSchema = z.object({
  expectedRevision: z.number().int().positive(),
  mutationId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
}).strict();

type Context = { params: Promise<{ projectId: string; assetId: string }> };

function fallbackFilename(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "asset.png";
    case "image/jpeg": return "asset.jpg";
    case "image/webp": return "asset.webp";
    case "image/svg+xml": return "asset.svg";
    case "audio/wav": return "asset.wav";
    case "audio/mpeg": return "asset.mp3";
    case "audio/mp4": return "asset.m4a";
    default: return "asset.bin";
  }
}

function responseFilename(filename: string, mimeType: string): string {
  try {
    return sanitizeAssetFilename(filename);
  } catch {
    return fallbackFilename(mimeType);
  }
}

export async function GET(request: Request, context: Context) {
  try {
    authenticateRequest(request);
    const { projectId, assetId } = await context.params;
    const result = projectRepository().getProjectAsset({ projectId, assetId });
    const filename = responseFilename(result.asset.filename, result.asset.mimeType);
    return new Response(result.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type": result.asset.mimeType,
        "Content-Length": String(result.bytes.byteLength),
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cross-Origin-Resource-Policy": "same-origin",
        ETag: `"sha256-${result.asset.sha256}"`,
        ...(result.asset.mimeType === "image/svg+xml"
          ? { "Content-Security-Policy": "default-src 'none'; sandbox" }
          : {}),
      },
    });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    authorizeStateChangingRequest(request);
    const { projectId, assetId } = await context.params;
    const input = DeleteSchema.parse(await readJsonRequest(request, 8 * 1_024));
    const result = projectRepository().deleteProjectAsset({ projectId, assetId, ...input });
    return jsonNoStore({ ok: true, project: result.value, replayed: result.replayed });
  } catch (error) {
    return routeFailure(error);
  }
}
