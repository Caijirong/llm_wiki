// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  createProject,
  createDirectory,
  setProjectKind,
  saveOutputLanguage,
  writeFile,
} = vi.hoisted(() => ({
  createProject: vi.fn(async () => ({
    id: "project-123",
    name: "Manual Wiki",
    path: "/tmp/manual-wiki",
  })),
  writeFile: vi.fn(async () => {}),
  createDirectory: vi.fn(async () => {}),
  setProjectKind: vi.fn(async () => {}),
  saveOutputLanguage: vi.fn(async () => {}),
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}))

vi.mock("@/commands/fs", () => ({
  createProject,
  writeFile,
  createDirectory,
}))

vi.mock("@/lib/project-identity", () => ({
  setProjectKind,
}))

vi.mock("@/lib/project-store", () => ({
  saveOutputLanguage,
}))

import { CreateProjectDialog } from "./create-project-dialog"

describe("CreateProjectDialog document-manual template", () => {
  beforeEach(() => {
    createProject.mockClear()
    writeFile.mockClear()
    createDirectory.mockClear()
    setProjectKind.mockClear()
    saveOutputLanguage.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it("writes projectKind=document-manual after creating a Document / Manual project", async () => {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <CreateProjectDialog
        open
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />,
    )

    await user.type(screen.getByLabelText(/Project Name/i), "Manual Wiki")
    await user.click(screen.getByRole("button", { name: /Document \/ Manual/i }))
    await user.selectOptions(screen.getByLabelText(/AI Output Language/i), "Chinese")
    await user.type(screen.getByLabelText(/Parent Directory/i), "/tmp")
    await user.click(screen.getByRole("button", { name: /^Create$/i }))

    await waitFor(() =>
      expect(setProjectKind).toHaveBeenCalledWith(
        "/tmp/manual-wiki",
        "document-manual",
      ),
    )

    expect(onCreated).toHaveBeenCalledWith({
      id: "project-123",
      name: "Manual Wiki",
      path: "/tmp/manual-wiki",
    })
  })
})
