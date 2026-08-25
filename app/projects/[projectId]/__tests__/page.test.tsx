import { cleanup, render, screen } from "@testing-library/react";

jest.mock("next/navigation", () => ({ notFound: jest.fn(), redirect: jest.fn() }));
jest.mock("../../../ProofCanvasEditor", () => ({ __esModule: true, default: () => <div>Editor</div> }));
jest.mock("@/lib/proofcanvas/auth.server", () => {
  class ProofCanvasAuthError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  }
  return { ProofCanvasAuthError, authenticatedPageSession: jest.fn(async () => ({ csrfToken: "csrf" })) };
});
jest.mock("@/lib/proofcanvas/repository.server", () => {
  class ProjectRepositoryError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  }
  const getProject = jest.fn();
  const legacyRecoveryDocument = jest.fn();
  const listCheckpoints = jest.fn();
  return {
    ProjectRepositoryError,
    projectRepository: jest.fn(() => ({ getProject, legacyRecoveryDocument, listCheckpoints })),
    __repositoryMocks: { getProject, legacyRecoveryDocument, listCheckpoints },
  };
});

import { ProjectRepositoryError } from "@/lib/proofcanvas/repository.server";
import DurableProjectPage from "../page";

const { __repositoryMocks: repository } = jest.requireMock("@/lib/proofcanvas/repository.server") as {
  __repositoryMocks: { getProject: jest.Mock; legacyRecoveryDocument: jest.Mock; listCheckpoints: jest.Mock };
};

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

test("renders exact read-only recovery instead of failing the durable project page", async () => {
  const projectId = "project-111111111111111111111111";
  const checkpointId = "checkpoint-222222222222222222222222";
  repository.getProject.mockImplementation(() => {
    throw new ProjectRepositoryError(409, "project_recovery_required", "Exact legacy export required");
  });
  repository.legacyRecoveryDocument.mockReturnValue({
    ownerType: "project",
    ownerId: projectId,
    projectId,
    sha256: "a".repeat(64),
    reason: "Two distinct authored events collapse to one timeline tick",
    documentJson: "{}\n",
  });
  repository.listCheckpoints.mockReturnValue([
    { id: checkpointId, projectId, revision: 2, label: "Legacy checkpoint", createdAt: "2026-08-24T00:00:00.000Z", recoveryRequired: true },
    { id: "checkpoint-333333333333333333333333", projectId, revision: 1, label: "Ready checkpoint", createdAt: "2026-08-23T00:00:00.000Z", recoveryRequired: false },
  ]);

  render(await DurableProjectPage({ params: Promise.resolve({ projectId }) }));
  expect(screen.getByRole("heading", { name: /cannot be moved to the 10ns timeline/i })).toBeInTheDocument();
  expect(screen.getByText(/Two distinct authored events collapse/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Export exact legacy JSON" })).toHaveAttribute("href", `/api/projects/${projectId}/legacy-export`);
  expect(screen.getByRole("link", { name: "Export exact JSON" })).toHaveAttribute("href", `/api/projects/${projectId}/legacy-export?checkpointId=${checkpointId}`);
  expect(screen.queryByText("Ready checkpoint")).not.toBeInTheDocument();
});
