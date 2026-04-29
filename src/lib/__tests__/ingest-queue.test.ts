import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

const ingestMocks = vi.hoisted(() => ({
  autoIngest: vi.fn(),
}))

const projectIdentityMocks = vi.hoisted(() => ({
  getProjectPathById: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}))

vi.mock("@/lib/ingest", () => ({
  autoIngest: ingestMocks.autoIngest,
}))

vi.mock("@/lib/project-identity", () => ({
  getProjectPathById: projectIdentityMocks.getProjectPathById,
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

const TEST_ID = "project-a"
const TEST_PATH = "/tmp/project"

function makeTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    projectId: TEST_ID,
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
  for (let i = 0; i < 50; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Condition was not met in time")
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fsMocks.writeFile.mockResolvedValue(undefined)
  fsMocks.readFile.mockRejectedValue(new Error("queue file not found"))
  ingestMocks.autoIngest.mockResolvedValue(["wiki/entities/a.md"])
  projectIdentityMocks.getProjectPathById.mockResolvedValue(TEST_PATH)
})

describe("ingest queue MCP history compatibility", () => {
  it("loads and persists done history with MCP metadata", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify([
      makeTask({
        id: "task-done",
        status: "done",
        origin: "mcp",
        mimeType: "application/pdf",
        startedAt: 1700000001000,
        finishedAt: 1700000002000,
        filesWritten: ["wiki/entities/a.md"],
        reviewItemCount: 4,
        cacheHit: true,
      }),
    ]))

    const { restoreQueue, getQueue, getQueueSummary } = await import("@/lib/ingest-queue")
    await restoreQueue(TEST_ID, TEST_PATH)

    expect(getQueue()).toEqual([])
    expect(getQueueSummary()).toMatchObject({
      done: 1,
      history: 1,
      recordsTotal: 1,
      total: 0,
    })

    const lastWritePayload = fsMocks.writeFile.mock.calls[fsMocks.writeFile.mock.calls.length - 1]?.[1]
    expect(JSON.parse(String(lastWritePayload))[0]).toMatchObject({
      id: "task-done",
      origin: "mcp",
      mimeType: "application/pdf",
      filesWritten: ["wiki/entities/a.md"],
      reviewItemCount: 4,
      cacheHit: true,
    })
  })

  it("pulls externally appended MCP tasks from disk and records success metadata", async () => {
    let queueReadCount = 0
    fsMocks.readFile.mockImplementation(async (filePath: string) => {
      if (!String(filePath).includes(".llm-wiki/ingest-queue.json")) {
        throw new Error(`unexpected read: ${filePath}`)
      }
      queueReadCount++
      if (queueReadCount === 1) return "[]"
      return JSON.stringify([
        makeTask({
          id: "task-external",
          sourcePath: "raw/sources/external.pdf",
          folderContext: "Inbox",
          status: "pending",
          origin: "mcp",
        }),
      ])
    })
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
      await options?.onQueueMetadata?.(options.queueTaskId ?? "", {
        cacheHit: false,
        reviewItemCount: 2,
      })
      return ["wiki/entities/external.md"]
    })

    const { restoreQueue, syncQueueFromDisk, getQueueSummary } = await import("@/lib/ingest-queue")
    await restoreQueue(TEST_ID, TEST_PATH)
    await syncQueueFromDisk(TEST_ID, TEST_PATH)
    await waitUntil(() => getQueueSummary().done === 1)

    expect(ingestMocks.autoIngest).toHaveBeenCalledTimes(1)
    const lastWritePayload = fsMocks.writeFile.mock.calls[fsMocks.writeFile.mock.calls.length - 1]?.[1]
    expect(JSON.parse(String(lastWritePayload))[0]).toMatchObject({
      id: "task-external",
      status: "done",
      origin: "mcp",
      filesWritten: ["wiki/entities/external.md"],
      reviewItemCount: 2,
    })
  })
})

describe("ingest queue source path resolution", () => {
  it.each([
    ["/Users/me/source.docx", "/Users/me/source.docx"],
    ["C:/Users/me/source.docx", "C:/Users/me/source.docx"],
    ["//server/share/source.docx", "//server/share/source.docx"],
    ["raw/sources/source.docx", `${TEST_PATH}/raw/sources/source.docx`],
  ])("passes %s to autoIngest as %s", async (sourcePath, expectedFullPath) => {
    const { restoreQueue, enqueueIngest, getQueueSummary } = await import("@/lib/ingest-queue")
    await restoreQueue(TEST_ID, TEST_PATH)

    await enqueueIngest(TEST_ID, sourcePath)
    await waitUntil(() => getQueueSummary().done === 1)

    expect(ingestMocks.autoIngest).toHaveBeenCalledWith(
      TEST_PATH,
      expectedFullPath,
      expect.any(Object),
      expect.any(AbortSignal),
      "",
      expect.any(Object),
    )
  })
})
