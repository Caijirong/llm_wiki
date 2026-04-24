import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

const ingestMocks = vi.hoisted(() => ({
  autoIngest: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}))

vi.mock("@/lib/ingest", () => ({
  autoIngest: ingestMocks.autoIngest,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => ({
      llmConfig: {
        provider: "ollama",
        apiKey: "",
        model: "test-model",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "",
        maxContextSize: 204800,
      },
    }),
  },
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: (value: string) => value,
}))

function makeLegacyTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-legacy-1",
    sourcePath: "raw/sources/a.pdf",
    folderContext: "",
    status: "pending",
    addedAt: 1700000000000,
    error: null,
    retryCount: 0,
    ...overrides,
  }
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Condition was not met in time")
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fsMocks.writeFile.mockResolvedValue(undefined)
  ingestMocks.autoIngest.mockResolvedValue([])
})

describe("ingest queue restore and persistence compatibility", () => {
  it("loads legacy tasks without MCP metadata", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify([
      makeLegacyTask({ status: "done" }),
    ]))

    const { restoreQueue, getQueue, getQueueSummary } = await import("@/lib/ingest-queue")
    await restoreQueue("/tmp/project")

    const tasks = getQueue()
    expect(tasks).toEqual([])

    const summary = getQueueSummary()
    expect(summary.done).toBe(1)
    expect(summary.total).toBe(0)
    expect(summary.recordsTotal).toBe(1)

    const writes = fsMocks.writeFile.mock.calls
    const lastWritePayload = writes[writes.length - 1]?.[1]
    const persistedTask = JSON.parse(String(lastWritePayload))[0] as Record<string, unknown>
    expect(persistedTask.id).toBe("task-legacy-1")
    expect(persistedTask.origin).toBeUndefined()
    expect(persistedTask.mimeType).toBeUndefined()
    expect(persistedTask.startedAt).toBeUndefined()
    expect(persistedTask.finishedAt).toBeUndefined()
    expect(persistedTask.filesWritten).toBeUndefined()
    expect(persistedTask.reviewItemCount).toBeUndefined()
    expect(persistedTask.cacheHit).toBeUndefined()
  })

  it("loads and persists approved optional MCP-compatible fields", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify([
      makeLegacyTask({
        status: "done",
        origin: "mcp",
        mimeType: "application/pdf",
        startedAt: 1700000001000,
        finishedAt: 1700000002000,
        filesWritten: ["wiki/entities/a.md", "wiki/concepts/b.md"],
        reviewItemCount: 4,
        cacheHit: true,
      }),
    ]))

    const { restoreQueue, getQueue, getQueueSummary } = await import("@/lib/ingest-queue")
    await restoreQueue("/tmp/project")

    expect(getQueue()).toEqual([])
    expect(getQueueSummary()).toMatchObject({
      done: 1,
      total: 0,
      recordsTotal: 1,
    })

    const writes = fsMocks.writeFile.mock.calls
    const lastWritePayload = writes[writes.length - 1]?.[1]
    expect(typeof lastWritePayload).toBe("string")
    expect(JSON.parse(String(lastWritePayload))[0]).toMatchObject({
      origin: "mcp",
      mimeType: "application/pdf",
      startedAt: 1700000001000,
      finishedAt: 1700000002000,
      filesWritten: ["wiki/entities/a.md", "wiki/concepts/b.md"],
      reviewItemCount: 4,
      cacheHit: true,
    })
  })

  it("keeps done tasks in persisted history without making them active work", async () => {
    ingestMocks.autoIngest.mockResolvedValue(["wiki/entities/success.md"])
    fsMocks.readFile.mockRejectedValue(new Error("queue file not found"))

    const { enqueueIngest, getQueue, getQueueSummary } = await import("@/lib/ingest-queue")
    await enqueueIngest("/tmp/project", "raw/sources/success.pdf", "papers")
    await waitUntil(() => getQueueSummary().done === 1)

    const summary = getQueueSummary()
    expect(summary.pending).toBe(0)
    expect(summary.processing).toBe(0)
    expect(summary.active).toBe(0)
    expect(summary.done).toBe(1)
    expect(summary.history).toBe(1)
    expect(summary.recordsTotal).toBe(1)
    expect(summary.total).toBe(0)
    expect(getQueue()).toEqual([])

    const writes = fsMocks.writeFile.mock.calls
    const lastWritePayload = writes[writes.length - 1]?.[1]
    expect(typeof lastWritePayload).toBe("string")
    expect(JSON.parse(String(lastWritePayload))).toMatchObject([
      {
        status: "done",
        sourcePath: "raw/sources/success.pdf",
        filesWritten: ["wiki/entities/success.md"],
      },
    ])
  })

  it("persists cache-hit metadata updates from autoIngest", async () => {
    ingestMocks.autoIngest.mockImplementation(async (
      _projectPath: string,
      _sourcePath: string,
      _llmConfig: unknown,
      _signal?: AbortSignal,
      _folderContext?: string,
      options?: {
        queueTaskId?: string
        onQueueMetadata?: (taskId: string, patch: Record<string, unknown>) => Promise<void> | void
      },
    ) => {
      if (options?.queueTaskId && options.onQueueMetadata) {
        await options.onQueueMetadata(options.queueTaskId, {
          cacheHit: true,
          filesWritten: ["wiki/entities/from-cache.md"],
        })
      }
      return ["wiki/entities/from-cache.md"]
    })
    fsMocks.readFile.mockRejectedValue(new Error("queue file not found"))

    const { enqueueIngest, getQueueSummary } = await import("@/lib/ingest-queue")
    await enqueueIngest("/tmp/project", "raw/sources/cache-hit.pdf", "papers")
    await waitUntil(() => getQueueSummary().done === 1)

    const writes = fsMocks.writeFile.mock.calls
    const lastWritePayload = writes[writes.length - 1]?.[1]
    const persistedTask = JSON.parse(String(lastWritePayload))[0] as Record<string, unknown>
    expect(persistedTask.status).toBe("done")
    expect(persistedTask.cacheHit).toBe(true)
    expect(persistedTask.filesWritten).toEqual(["wiki/entities/from-cache.md"])
  })

  it("persists success metadata including reviewItemCount and finishedAt", async () => {
    ingestMocks.autoIngest.mockImplementation(async (
      _projectPath: string,
      _sourcePath: string,
      _llmConfig: unknown,
      _signal?: AbortSignal,
      _folderContext?: string,
      options?: {
        queueTaskId?: string
        onQueueMetadata?: (taskId: string, patch: Record<string, unknown>) => Promise<void> | void
      },
    ) => {
      if (options?.queueTaskId && options.onQueueMetadata) {
        await options.onQueueMetadata(options.queueTaskId, {
          cacheHit: false,
          filesWritten: ["wiki/entities/generated.md", "wiki/sources/generated.md"],
          reviewItemCount: 2,
        })
      }
      return ["wiki/entities/generated.md", "wiki/sources/generated.md"]
    })
    fsMocks.readFile.mockRejectedValue(new Error("queue file not found"))

    const { enqueueIngest, getQueueSummary } = await import("@/lib/ingest-queue")
    await enqueueIngest("/tmp/project", "raw/sources/normal.pdf", "papers")
    await waitUntil(() => getQueueSummary().done === 1)

    const writes = fsMocks.writeFile.mock.calls
    const lastWritePayload = writes[writes.length - 1]?.[1]
    const persistedTask = JSON.parse(String(lastWritePayload))[0] as Record<string, unknown>
    expect(persistedTask.status).toBe("done")
    expect(persistedTask.cacheHit).toBe(false)
    expect(persistedTask.filesWritten).toEqual(["wiki/entities/generated.md", "wiki/sources/generated.md"])
    expect(persistedTask.reviewItemCount).toBe(2)
    expect(typeof persistedTask.finishedAt).toBe("number")
  })

  it("keeps active distinct from history while total also includes failed visibility", async () => {
    ingestMocks.autoIngest.mockImplementation(
      () => new Promise<string[]>((_resolve) => {}),
    )

    fsMocks.readFile.mockResolvedValue(JSON.stringify([
      makeLegacyTask({ id: "task-pending", status: "pending" }),
      makeLegacyTask({ id: "task-processing", status: "processing", sourcePath: "raw/sources/b.pdf" }),
      makeLegacyTask({ id: "task-done", status: "done", sourcePath: "raw/sources/c.pdf" }),
      makeLegacyTask({ id: "task-failed", status: "failed", sourcePath: "raw/sources/d.pdf", error: "bad file" }),
    ]))

    const { restoreQueue, getQueue, getQueueSummary } = await import("@/lib/ingest-queue")
    await restoreQueue("/tmp/project")

    const queue = getQueue()
    const restoredProcessing = queue.find((task) => task.id === "task-processing")
    expect(restoredProcessing?.status).toBe("pending")
    const activeProcessing = queue.find((task) => task.status === "processing")
    expect(activeProcessing?.startedAt).toBeTypeOf("number")
    expect(activeProcessing?.error).toBeNull()

    const summary = getQueueSummary()
    expect(summary.pending).toBe(1)
    expect(summary.processing).toBe(1)
    expect(summary.active).toBe(2)
    expect(summary.done).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.history).toBe(2)
    expect(summary.recordsTotal).toBe(4)
    expect(summary.total).toBe(3)
  })

  it("clears singleton queue state when switching to a project with empty queue", async () => {
    ingestMocks.autoIngest.mockImplementation(
      () => new Promise<string[]>((_resolve) => {}),
    )

    fsMocks.readFile.mockImplementation(async (filePath: string) => {
      if (filePath.includes("/tmp/project-a/")) {
        return JSON.stringify([
          makeLegacyTask({
            id: "task-a-1",
            sourcePath: "raw/sources/a-only.pdf",
            status: "done",
          }),
        ])
      }
      throw new Error("queue file not found")
    })

    const { restoreQueue, getQueue, getQueueSummary, enqueueIngest } = await import("@/lib/ingest-queue")

    await restoreQueue("/tmp/project-a")
    expect(getQueue()).toEqual([])
    expect(getQueueSummary()).toMatchObject({
      done: 1,
      total: 0,
      recordsTotal: 1,
    })

    await restoreQueue("/tmp/project-b")
    expect(getQueue()).toEqual([])

    await enqueueIngest("/tmp/project-b", "raw/sources/b-only.pdf", "")

    const projectBWrites = fsMocks.writeFile.mock.calls.filter((call) =>
      String(call[0]).includes("/tmp/project-b/.llm-wiki/ingest-queue.json"),
    )
    expect(projectBWrites.length).toBeGreaterThan(0)

    const lastProjectBPayload = projectBWrites[projectBWrites.length - 1]?.[1]
    const persistedBQueue = JSON.parse(String(lastProjectBPayload)) as Array<{ sourcePath: string }>
    expect(persistedBQueue.map((task) => task.sourcePath)).toEqual(["raw/sources/b-only.pdf"])
  })

  it("keeps failed-only retained queues visible via total", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify([
      makeLegacyTask({
        id: "task-failed-only",
        status: "failed",
        sourcePath: "raw/sources/failed-only.pdf",
        error: "parse failed",
      }),
    ]))

    const { restoreQueue, getQueue, getQueueSummary } = await import("@/lib/ingest-queue")
    await restoreQueue("/tmp/project")

    expect(getQueue()).toHaveLength(1)
    expect(getQueue()[0]?.status).toBe("failed")

    const summary = getQueueSummary()
    expect(summary.pending).toBe(0)
    expect(summary.processing).toBe(0)
    expect(summary.active).toBe(0)
    expect(summary.done).toBe(0)
    expect(summary.failed).toBe(1)
    expect(summary.history).toBe(1)
    expect(summary.recordsTotal).toBe(1)
    expect(summary.total).toBe(1)
  })

  it("keeps summary.total from counting retained done history in mixed queues", async () => {
    ingestMocks.autoIngest.mockImplementation(
      () => new Promise<string[]>((_resolve) => {}),
    )

    fsMocks.readFile.mockResolvedValue(JSON.stringify([
      makeLegacyTask({ id: "task-done-history", status: "done", sourcePath: "raw/sources/old-done.pdf" }),
      makeLegacyTask({ id: "task-new", status: "pending", sourcePath: "raw/sources/new.pdf" }),
    ]))

    const { restoreQueue, getQueue, getQueueSummary } = await import("@/lib/ingest-queue")
    await restoreQueue("/tmp/project")

    expect(getQueue()).toHaveLength(1)
    expect(getQueue()[0]?.status).toBe("processing")

    const summary = getQueueSummary()
    expect(summary.pending).toBe(0)
    expect(summary.processing).toBe(1)
    expect(summary.active).toBe(1)
    expect(summary.done).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.history).toBe(1)
    expect(summary.recordsTotal).toBe(2)
    expect(summary.total).toBe(1)
  })

  it("pulls in externally appended pending tasks and starts processing them", async () => {
    let queueReadCount = 0
    fsMocks.readFile.mockImplementation(async (filePath: string) => {
      if (!String(filePath).includes(".llm-wiki/ingest-queue.json")) {
        throw new Error(`unexpected read: ${filePath}`)
      }

      queueReadCount++
      if (queueReadCount === 1) {
        return JSON.stringify([])
      }

      return JSON.stringify([
        makeLegacyTask({
          id: "task-external-mcp",
          sourcePath: "raw/sources/external.pdf",
          folderContext: "Inbox",
          status: "pending",
          origin: "mcp",
        }),
      ])
    })
    ingestMocks.autoIngest.mockResolvedValue(["wiki/entities/external.md"])

    const { restoreQueue, syncQueueFromDisk, getQueueSummary } = await import("@/lib/ingest-queue")

    await restoreQueue("/tmp/project")
    expect(getQueueSummary().total).toBe(0)

    await syncQueueFromDisk("/tmp/project")
    await waitUntil(() => getQueueSummary().done === 1)

    expect(ingestMocks.autoIngest).toHaveBeenCalledTimes(1)
    expect(getQueueSummary()).toMatchObject({
      pending: 0,
      processing: 0,
      done: 1,
      total: 0,
      recordsTotal: 1,
    })
  })
})
