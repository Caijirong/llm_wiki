// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queueState = vi.hoisted(() => ({
  tasks: [] as Array<{
    id: string
    projectId: string
    sourcePath: string
    folderContext: string
    status: "pending" | "processing" | "done" | "failed"
    addedAt: number
    error: string | null
    retryCount: number
  }>,
}))

const {
  getQueue,
  getQueueSummary,
  retryTask,
  cancelTask,
  cancelAllTasks,
  clearCompletedTasks,
  syncQueueFromDisk,
} = vi.hoisted(() => ({
  getQueue: vi.fn(() => queueState.tasks),
  getQueueSummary: vi.fn(() => {
    const pending = queueState.tasks.filter((task) => task.status === "pending").length
    const processing = queueState.tasks.filter((task) => task.status === "processing").length
    const failed = queueState.tasks.filter((task) => task.status === "failed").length
    const done = queueState.tasks.filter((task) => task.status === "done").length
    return {
      total: queueState.tasks.length,
      pending,
      processing,
      failed,
      history: done + failed,
    }
  }),
  retryTask: vi.fn(),
  cancelTask: vi.fn(),
  cancelAllTasks: vi.fn(),
  clearCompletedTasks: vi.fn(async () => {
    queueState.tasks = queueState.tasks.filter(
      (task) => task.status === "pending" || task.status === "processing",
    )
  }),
  syncQueueFromDisk: vi.fn(async (_projectId: string, _projectPath: string) => {}),
}))

vi.mock("@/lib/ingest-queue", () => ({
  getQueue: () => getQueue(),
  getQueueSummary: () => getQueueSummary(),
  retryTask: (taskId: string) => retryTask(taskId),
  cancelTask: (taskId: string) => cancelTask(taskId),
  cancelAllTasks: () => cancelAllTasks(),
  clearCompletedTasks: () => clearCompletedTasks(),
  syncQueueFromDisk: (projectId: string, projectPath: string) => syncQueueFromDisk(projectId, projectPath),
}))

import { ActivityPanel } from "./activity-panel"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"

describe("ActivityPanel queue cleanup", () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    queueState.tasks = [
      {
        id: "task-1",
        projectId: "project-1",
        sourcePath: "raw/sources/legacy.doc",
        folderContext: "",
        status: "failed",
        addedAt: Date.now(),
        error: "Text extraction not supported for .doc format",
        retryCount: 1,
      },
    ]
    getQueue.mockClear()
    getQueueSummary.mockClear()
    retryTask.mockClear()
    cancelTask.mockClear()
    cancelAllTasks.mockClear()
    clearCompletedTasks.mockClear()
    syncQueueFromDisk.mockClear()

    useWikiStore.setState({
      project: {
        id: "project-1",
        name: "Demo Project",
        path: "/tmp/wiki",
      },
    })
    useActivityStore.setState({ items: [] })
  })

  it("shows clear completed for failed queue items and removes them immediately", async () => {
    const user = userEvent.setup()
    render(<ActivityPanel />)

    await screen.findByText("legacy.doc")
    const clearButton = await screen.findByRole("button", { name: /clear completed/i })

    await user.click(clearButton)

    await waitFor(() => expect(clearCompletedTasks).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByText("legacy.doc")).not.toBeInTheDocument())
  })
})
