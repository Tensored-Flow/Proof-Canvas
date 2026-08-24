import { redirect } from "next/navigation";
import ProjectDashboard from "./ProjectDashboard";
import { ProofCanvasAuthError, authenticatedPageSession } from "@/lib/proofcanvas/auth.server";
import { projectRepository } from "@/lib/proofcanvas/repository.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DashboardPage() {
  try {
    const { csrfToken } = await authenticatedPageSession();
    return <ProjectDashboard initialProjects={projectRepository().listProjects()} initialCsrfToken={csrfToken} />;
  } catch (error) {
    if (error instanceof ProofCanvasAuthError && error.code === "unauthorized") redirect("/login");
    throw error;
  }
}
