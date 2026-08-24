import { notFound, redirect } from "next/navigation";
import ProofCanvasEditor from "../../ProofCanvasEditor";
import { ProofCanvasAuthError, authenticatedPageSession } from "@/lib/proofcanvas/auth.server";
import { ProjectRepositoryError, projectRepository } from "@/lib/proofcanvas/repository.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DurableProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  try {
    const [{ csrfToken }, { projectId }] = await Promise.all([authenticatedPageSession(), params]);
    const durable = projectRepository().getProject(projectId);
    const aiConfigured = Boolean(process.env.OPENAI_API_KEY?.trim() && process.env.PROOFCANVAS_OPENAI_MODEL?.trim());
    return <ProofCanvasEditor
      aiConfigured={aiConfigured}
      initialProject={durable.document}
      durableProject={{ projectId: durable.id, revision: durable.revision, csrfToken }}
    />;
  } catch (error) {
    if (error instanceof ProofCanvasAuthError && error.code === "unauthorized") redirect("/login");
    if (error instanceof ProjectRepositoryError && error.code === "project_not_found") notFound();
    throw error;
  }
}
