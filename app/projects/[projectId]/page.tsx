import { notFound, redirect } from "next/navigation";
import ProofCanvasEditor from "../../ProofCanvasEditor";
import { ProofCanvasAuthError, authenticatedPageSession } from "@/lib/proofcanvas/auth.server";
import { ProjectRepositoryError, projectRepository } from "@/lib/proofcanvas/repository.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DurableProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  try {
    const [{ csrfToken }, { projectId }] = await Promise.all([authenticatedPageSession(), params]);
    const repository = projectRepository();
    let durable: ReturnType<typeof repository.getProject>;
    try {
      durable = repository.getProject(projectId);
    } catch (error) {
      if (!(error instanceof ProjectRepositoryError) || error.code !== "project_recovery_required") throw error;
      const recovery = repository.legacyRecoveryDocument({ projectId });
      const recoveryCheckpoints = repository.listCheckpoints(projectId).filter(({ recoveryRequired }) => recoveryRequired);
      return <main className="pc-dashboard pc-recovery-required" data-project-id={projectId}>
        <header className="pc-dashboard-header"><div><span aria-hidden="true">∴</span><div><h1>ProofCanvas</h1><p>Exact schema-v2 recovery</p></div></div><a href="/">Projects</a></header>
        <section className="pc-dashboard-intro" aria-labelledby="legacy-recovery-heading">
          <div><p className="pc-eyebrow">Read-only recovery required</p><h2 id="legacy-recovery-heading">This project cannot be moved to the 10ns timeline without changing authored chronology.</h2><p>{recovery.reason}</p><p>ProofCanvas preserved the original schema-v2 JSON byte-for-byte. Export it before performing any manual recovery; editing, AI, render, rename, duplicate, checkpoint, and delete actions remain disabled for this row.</p></div>
          <div><a className="pc-dashboard-primary" href={`/api/projects/${encodeURIComponent(projectId)}/legacy-export`}>Export exact legacy JSON</a><p><small>SHA-256: <code>{recovery.sha256}</code></small></p></div>
        </section>
        {recoveryCheckpoints.length > 0 && <section aria-label="Legacy checkpoint exports"><h2>Checkpoint exports</h2><ul>{recoveryCheckpoints.map((checkpoint) => <li key={checkpoint.id}><span>{checkpoint.label} · revision {checkpoint.revision}</span> <a href={`/api/projects/${encodeURIComponent(projectId)}/legacy-export?checkpointId=${encodeURIComponent(checkpoint.id)}`}>Export exact JSON</a></li>)}</ul></section>}
      </main>;
    }
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
