import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import path from "node:path"
import fs from "node:fs/promises"
import { realFs, createTempProject } from "@/test-helpers/fs-temp"

const listeners = new Map<string, (event: { payload: unknown }) => void | Promise<void>>()
const mockInvoke = vi.fn()

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void | Promise<void>) => {
    listeners.set(name, callback)
    return () => listeners.delete(name)
  }),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock("@/commands/fs", () => realFs)

const mockSearchByEmbedding =
  vi.fn<(...args: unknown[]) => Promise<Array<{ id: string; score: number }>>>()

vi.mock("./embedding", () => ({
  searchByEmbedding: (...args: unknown[]) => mockSearchByEmbedding(...args),
}))

import {
  MCP_RETRIEVAL_REQUEST_EVENT,
  startMcpRetrievalBridge,
  stopMcpRetrievalBridge,
} from "./mcp-retrieval-bridge"
import { clearGraphCache } from "./graph-relevance"
import { useWikiStore } from "@/stores/wiki-store"

let tmp: { path: string; cleanup: () => Promise<void> } | undefined

async function writeProject(files: Record<string, string>): Promise<string> {
  tmp = await createTempProject("mcp-retrieval-bridge")
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmp.path, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, "utf-8")
  }
  return tmp.path
}

beforeEach(() => {
  clearGraphCache()
  listeners.clear()
  mockInvoke.mockReset()
  mockSearchByEmbedding.mockReset()
  useWikiStore.getState().setEmbeddingConfig({
    enabled: true,
    endpoint: "http://test/v1/embeddings",
    apiKey: "",
    model: "test-embed",
  })
})

afterEach(async () => {
  stopMcpRetrievalBridge()
  clearGraphCache()
  listeners.clear()
  if (tmp) {
    await tmp.cleanup()
    tmp = undefined
  }
})

describe("startMcpRetrievalBridge", () => {
  it("answers MCP retrieval requests with the shared chat retrieval results", async () => {
    const projectPath = await writeProject({
      "purpose.md": "# Purpose\nAnswer from the wiki.",
      "schema.md": "# Schema\n",
      "wiki/index.md": "# Index\n- [[flash-attention]]\n",
      "wiki/concepts/flash-attention.md":
        "---\ntitle: Flash Attention\ntype: concept\n---\n\n# Flash Attention\n\nIO-aware tiled attention.",
      "wiki/concepts/memory-leak.md":
        "---\ntitle: Memory Leak\ntype: concept\n---\n\n# Memory Leak\n\nRSS grows over time.",
    })

    mockSearchByEmbedding.mockResolvedValueOnce([
      { id: "flash-attention", score: 0.91 },
      { id: "memory-leak", score: 0.4 },
    ])

    const stop = await startMcpRetrievalBridge()
    const handler = listeners.get(MCP_RETRIEVAL_REQUEST_EVENT)
    expect(handler).toBeTypeOf("function")

    await handler?.({
      payload: {
        requestId: "req-1",
        kind: "context",
        projectId: "wiki-test",
        projectPath,
        query: "GPU memory bandwidth optimization for attention",
        maxPages: 5,
        pageCharLimit: 4_000,
      },
    })

    expect(mockInvoke).toHaveBeenCalledWith("mcp_complete_retrieval", {
      completion: expect.objectContaining({
        requestId: "req-1",
        ok: true,
        response: expect.objectContaining({
          projectId: "wiki-test",
          warning: null,
          results: expect.arrayContaining([
            expect.objectContaining({
              title: "Flash Attention",
              relativePath: "concepts/flash-attention.md",
            }),
          ]),
          pages: expect.arrayContaining([
            expect.objectContaining({
              title: "Flash Attention",
              relativePath: "concepts/flash-attention.md",
              content: expect.stringContaining("IO-aware tiled attention"),
            }),
          ]),
          imageUsageInstructions: expect.stringContaining("If your client supports Markdown image rendering"),
          knowledgeImages: [],
        }),
      }),
    })

    stop()
  })

  it("keeps the shared listener active until all concurrent starts release it", async () => {
    const stopFirst = await startMcpRetrievalBridge()
    const stopSecond = await startMcpRetrievalBridge()

    expect(listeners.has(MCP_RETRIEVAL_REQUEST_EVENT)).toBe(true)

    stopFirst()
    expect(listeners.has(MCP_RETRIEVAL_REQUEST_EVENT)).toBe(true)

    stopSecond()
    expect(listeners.has(MCP_RETRIEVAL_REQUEST_EVENT)).toBe(false)
  })

  it("includes matching knowledge images with clip-server urls in MCP context responses", async () => {
    const projectPath = await writeProject({
      "purpose.md": "# Purpose\nAnswer from the wiki.",
      "schema.md": "# Schema\n",
      "wiki/index.md": "# Index\n- [[project-plan]]\n",
      "wiki/sources/project-plan.md": [
        "---",
        "title: Project Plan",
        "type: source",
        "---",
        "",
        "# Project Plan",
        "",
        "![图 3.2-5 无人机采集作业流程图。该流程图展示无人机数据采集的完整步骤。](media/project-plan/img-2.png)",
      ].join("\n"),
    })

    mockSearchByEmbedding.mockResolvedValueOnce([])

    const stop = await startMcpRetrievalBridge()
    const handler = listeners.get(MCP_RETRIEVAL_REQUEST_EVENT)

    await handler?.({
      payload: {
        requestId: "req-images",
        kind: "context",
        projectId: "wiki-test",
        projectPath,
        query: "无人机采集作业流程图",
        maxPages: 5,
        pageCharLimit: 4_000,
      },
    })

    expect(mockInvoke).toHaveBeenCalledWith("mcp_complete_retrieval", {
      completion: expect.objectContaining({
        requestId: "req-images",
        ok: true,
        response: expect.objectContaining({
          knowledgeImages: [
            expect.objectContaining({
              id: 1,
              title: "图 3.2-5 无人机采集作业流程图",
              alt: "图 3.2-5 无人机采集作业流程图。该流程图展示无人机数据采集的完整步骤。",
              sourcePath: "wiki/sources/project-plan.md",
              url: "http://127.0.0.1:19827/wiki-media/wiki-test/media/project-plan/img-2.png",
            }),
          ],
        }),
      }),
    })

    stop()
  })
})
