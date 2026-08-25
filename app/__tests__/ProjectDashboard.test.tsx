import { cleanup, render, screen, within } from "@testing-library/react";
import ProjectDashboard from "../ProjectDashboard";
import type { ProjectSummary } from "@/lib/proofcanvas/repository.server";

jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock("@/lib/proofcanvas/csrf.client", () => ({
  currentBrowserCsrfToken: () => "csrf",
  ensureSessionCsrfToken: async () => "csrf",
}));

afterEach(cleanup);

const base: ProjectSummary = {
  id: "project-111111111111111111111111",
  title: "Legacy proof",
  revision: 2,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:01.000Z",
  thumbnail: null,
  shotCount: 1,
  objectCount: 0,
  durationSeconds: 5,
  recoveryRequired: true,
};

test("renders a quarantined project as exact-export recovery and disables every mutation", () => {
  render(<ProjectDashboard initialProjects={[base]} initialCsrfToken="csrf" />);
  const card = screen.getByRole("article");
  expect(card).toHaveAttribute("data-recovery-required", "true");
  expect(within(card).getByText("Read-only recovery required")).toBeInTheDocument();
  expect(within(card).getByRole("link", { name: "Recovery export" })).toHaveAttribute("href", `/projects/${base.id}`);
  expect(within(card).getByRole("textbox", { name: "Title" })).toBeDisabled();
  expect(within(card).getByRole("button", { name: "Save title" })).toBeDisabled();
  expect(within(card).getByRole("button", { name: "Duplicate" })).toBeDisabled();
  expect(within(card).getByRole("button", { name: "Delete…" })).toBeDisabled();
});

test("keeps a ready project editable", () => {
  render(<ProjectDashboard initialProjects={[{ ...base, recoveryRequired: false }]} initialCsrfToken="csrf" />);
  const card = screen.getByRole("article");
  expect(card).toHaveAttribute("data-recovery-required", "false");
  expect(within(card).getByRole("link", { name: "Open" })).toHaveAttribute("href", `/projects/${base.id}`);
  expect(within(card).getByRole("textbox", { name: "Title" })).toBeEnabled();
  expect(within(card).getByRole("button", { name: "Duplicate" })).toBeEnabled();
});
