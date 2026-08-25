"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { currentBrowserCsrfToken, ensureSessionCsrfToken } from "@/lib/proofcanvas/csrf.client";
import type { ProjectSummary } from "@/lib/proofcanvas/repository.server";

interface Props {
  initialProjects: ProjectSummary[];
  initialCsrfToken: string | null;
}

const mutationId = () => crypto.randomUUID();

function responseMessage(value: unknown, fallback: string): string {
  return value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string"
    ? (value as { message: string }).message
    : fallback;
}

function displayTimestamp(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export default function ProjectDashboard({ initialProjects, initialCsrfToken }: Props) {
  const router = useRouter();
  const [projects, setProjects] = useState(initialProjects);
  const [csrfToken, setCsrfToken] = useState(initialCsrfToken);
  const [title, setTitle] = useState("Untitled proof");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [titles, setTitles] = useState<Record<string, string>>(() => Object.fromEntries(initialProjects.map((project) => [project.id, project.title])));

  useEffect(() => {
    if (csrfToken && currentBrowserCsrfToken() === csrfToken) return;
    void ensureSessionCsrfToken(csrfToken)
      .then(setCsrfToken)
      .catch((error) => setMessage(error instanceof Error ? error.message : "Secure session could not be refreshed"));
  }, [csrfToken]);

  const mutate = async (url: string, method: string, body?: object) => {
    const currentCsrfToken = await ensureSessionCsrfToken(csrfToken);
    if (currentCsrfToken !== csrfToken) setCsrfToken(currentCsrfToken);
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "X-ProofCanvas-CSRF": currentCsrfToken },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload: unknown = await response.json();
    if (!response.ok) throw new Error(responseMessage(payload, "Project request failed"));
    return payload as Record<string, unknown>;
  };

  const refreshProjects = async () => {
    const response = await fetch("/api/projects", { cache: "no-store" });
    const payload = await response.json() as { projects?: unknown };
    if (response.ok && Array.isArray(payload.projects)) {
      const next = payload.projects as ProjectSummary[];
      setProjects(next);
      setTitles(Object.fromEntries(next.map((project) => [project.id, project.title])));
    }
    router.refresh();
  };

  const createProject = async (kind: "blank" | "sample") => {
    setPending(`create-${kind}`);
    setMessage("");
    try {
      const payload = await mutate("/api/projects", "POST", { kind, title, mutationId: mutationId() });
      const project = payload.project as { projectId?: unknown };
      if (!project || typeof project.projectId !== "string") throw new Error("Project creation returned an invalid response");
      window.location.assign(`/projects/${project.projectId}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Project could not be created");
      setPending(null);
    }
  };

  const rename = async (project: ProjectSummary) => {
    const nextTitle = titles[project.id]?.trim();
    if (!nextTitle || nextTitle === project.title) return;
    setPending(`rename-${project.id}`);
    setMessage("");
    try {
      const payload = await mutate(`/api/projects/${encodeURIComponent(project.id)}`, "PATCH", { expectedRevision: project.revision, mutationId: mutationId(), title: nextTitle });
      const receipt = payload.project as { revision?: unknown; updatedAt?: unknown };
      if (typeof receipt.revision !== "number" || typeof receipt.updatedAt !== "string") throw new Error("Rename returned an invalid response");
      setProjects((current) => current.map((candidate) => candidate.id === project.id ? { ...candidate, title: nextTitle, revision: receipt.revision as number, updatedAt: receipt.updatedAt as string } : candidate));
      setMessage("Project renamed");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Project could not be renamed");
    } finally {
      setPending(null);
    }
  };

  const duplicate = async (project: ProjectSummary) => {
    setPending(`duplicate-${project.id}`);
    setMessage("");
    try {
      await mutate(`/api/projects/${encodeURIComponent(project.id)}/duplicate`, "POST", { expectedRevision: project.revision, mutationId: mutationId() });
      setMessage("Project duplicated");
      await refreshProjects();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Project could not be duplicated");
    } finally {
      setPending(null);
    }
  };

  const remove = async (project: ProjectSummary) => {
    if (!window.confirm(`Delete “${project.title}”? The project will be soft-deleted from this dashboard.`)) return;
    setPending(`delete-${project.id}`);
    setMessage("");
    try {
      await mutate(`/api/projects/${encodeURIComponent(project.id)}`, "DELETE", { expectedRevision: project.revision, mutationId: mutationId() });
      setProjects((current) => current.filter(({ id }) => id !== project.id));
      setMessage("Project deleted");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Project could not be deleted");
    } finally {
      setPending(null);
    }
  };

  const logout = async () => {
    setPending("logout");
    try {
      await mutate("/api/auth/logout", "POST");
      window.location.assign("/login");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Logout failed");
      setPending(null);
    }
  };

  return <main className="pc-dashboard">
    <header className="pc-dashboard-header"><div><span aria-hidden="true">∴</span><div><h1>ProofCanvas</h1><p>Private project studio</p></div></div><button type="button" onClick={() => void logout()} disabled={pending === "logout"}>Log out</button></header>
    <section className="pc-dashboard-intro" aria-labelledby="projects-heading">
      <div><p className="pc-eyebrow">Single-owner workspace</p><h2 id="projects-heading">Your mathematical motion projects</h2><p>Projects autosave to durable storage and remain private to this installation.</p></div>
      <form onSubmit={(event) => { event.preventDefault(); void createProject("blank"); }}><label htmlFor="new-project-title">Project title</label><input id="new-project-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required /><div><button className="pc-dashboard-primary" type="submit" disabled={!csrfToken || Boolean(pending)}>New blank project</button><button type="button" onClick={() => void createProject("sample")} disabled={!csrfToken || Boolean(pending)}>New sample project</button></div></form>
    </section>
    {message && <p className="pc-dashboard-message" role="status">{message}</p>}
    {projects.length === 0 ? <section className="pc-dashboard-empty"><h3>No projects yet</h3><p>Create a blank canvas or start from the editable Cantor-set sample.</p></section> : <section className="pc-project-grid" aria-label="Projects">
      {projects.map((project) => <article key={project.id} className="pc-project-card" data-project-id={project.id} data-recovery-required={project.recoveryRequired ? "true" : "false"}>
        <a className="pc-project-thumbnail" href={`/projects/${project.id}`} aria-label={`${project.recoveryRequired ? "Recover" : "Open"} ${project.title}`}>{project.thumbnail ? <span data-thumbnail-sha={project.thumbnail.sha256}>{project.thumbnail.mimeType.replace("image/", "").toUpperCase()} thumbnail</span> : <><span aria-hidden="true">∴</span><small>{project.recoveryRequired ? "Exact legacy export required" : "No thumbnail yet"}</small></>}</a>
        <div className="pc-project-card-body">{project.recoveryRequired && <p role="status"><strong>Read-only recovery required</strong><br/>The original schema-v2 JSON is preserved for exact export.</p>}<label><span>Title</span><input value={titles[project.id] ?? project.title} maxLength={160} disabled={project.recoveryRequired} onChange={(event) => setTitles((current) => ({ ...current, [project.id]: event.target.value }))} /></label>
          <dl><div><dt>Updated</dt><dd><time dateTime={project.updatedAt}>{displayTimestamp(project.updatedAt)}</time></dd></div><div><dt>Revision</dt><dd>{project.revision}</dd></div><div><dt>Scenes</dt><dd>{project.shotCount}</dd></div><div><dt>Objects</dt><dd>{project.objectCount}</dd></div><div><dt>Duration</dt><dd>{project.durationSeconds.toFixed(1)}s</dd></div></dl>
          <div className="pc-project-actions"><a href={`/projects/${project.id}`}>{project.recoveryRequired ? "Recovery export" : "Open"}</a><button type="button" onClick={() => void rename(project)} disabled={project.recoveryRequired || Boolean(pending) || titles[project.id]?.trim() === project.title}>Save title</button><button type="button" onClick={() => void duplicate(project)} disabled={project.recoveryRequired || Boolean(pending)}>Duplicate</button><button className="pc-danger-button" type="button" onClick={() => void remove(project)} disabled={project.recoveryRequired || Boolean(pending)}>Delete…</button></div>
        </div>
      </article>)}
    </section>}
  </main>;
}
