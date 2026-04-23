// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { fileReceiverStatus, listUploads } = vi.hoisted(() => ({
  fileReceiverStatus: vi.fn(async () => ({
    status: "running",
    host: "127.0.0.1",
    port: 18766,
    knownProjects: ["/tmp/wiki"],
    lastError: null,
    maxFileSizeBytes: 1024 * 1024 * 1024,
    uploadTtlHours: 168,
  })),
  listUploads: vi.fn(async () => ({
    total: 1,
    uploads: [
      {
        uploadId: "upload-1",
        projectPath: "/tmp/wiki",
        fileName: "report.pdf",
        mimeType: "application/pdf",
        folderContext: "docs > reports",
        status: "uploading",
        receivedBytes: 12 * 1024 * 1024,
        totalSize: null,
        storedSourcePath: null,
        taskId: null,
        error: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })),
}))

const {
  syncQueueFromDisk,
  getQueue,
  getQueueSummary,
} = vi.hoisted(() => ({
  syncQueueFromDisk: vi.fn(async () => {}),
  getQueue: vi.fn(() => [
    {
      id: "ingest-1",
      sourcePath: "raw/sources/report.pdf",
      folderContext: "docs > reports",
      status: "processing",
      addedAt: Date.now(),
      error: null,
      retryCount: 0,
    },
  ]),
  getQueueSummary: vi.fn(() => ({
    pending: 0,
    processing: 1,
    failed: 0,
    done: 2,
    active: 1,
    history: 2,
    recordsTotal: 3,
    total: 1,
  })),
}))

vi.mock("@/commands/fs", () => ({
  fileReceiverStatus,
  listUploads,
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock("@/lib/ingest-queue", () => ({
  syncQueueFromDisk,
  getQueue,
  getQueueSummary,
}))

import { TransfersView } from "./transfers-view"
import { useWikiStore } from "@/stores/wiki-store"

describe("TransfersView", () => {
  beforeEach(() => {
    useWikiStore.setState({
      project: {
        name: "Demo Project",
        path: "/tmp/wiki",
      },
    })
    fileReceiverStatus.mockClear()
    listUploads.mockClear()
    syncQueueFromDisk.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it("renders runtime status, upload history, and ingest queue state", async () => {
    render(<TransfersView />)

    await waitFor(() => expect(fileReceiverStatus).toHaveBeenCalled())
    await waitFor(() =>
      expect(listUploads).toHaveBeenCalledWith({ projectPath: "/tmp/wiki", limit: 50 })
    )
    expect(screen.getByRole("heading", { name: "transfers.title" })).toBeInTheDocument()
    expect(screen.getAllByText(/report\.pdf/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Processing/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/12\.0 MB/i).length).toBeGreaterThan(0)
  })
})
