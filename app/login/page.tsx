import { redirect } from "next/navigation";
import LoginForm from "./LoginForm";
import { ProofCanvasAuthError, authenticatedPageSession, proofCanvasAuthConfiguration } from "@/lib/proofcanvas/auth.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function LoginPage() {
  let configured = true;
  try {
    proofCanvasAuthConfiguration();
    await authenticatedPageSession();
    redirect("/");
  } catch (error) {
    if (error instanceof ProofCanvasAuthError) configured = error.code !== "auth_unavailable";
    else throw error;
  }
  return <LoginForm configured={configured} />;
}
