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
  it("answers MCP retrieval requests with shared search results", async () => {
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
        projectId: "wiki-test",
        projectPath,
        query: "GPU memory bandwidth optimization for attention",
        limit: 5,
      },
    })

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    const completion = mockInvoke.mock.calls[0]?.[1] as {
      completion: {
        requestId: string
        ok: boolean
        response: {
          projectId: string
          query: string
          warning: string | null
          results: Array<{
            title: string
            relativePath: string
            score: number
            snippet: string
            titleMatch: boolean
          }>
        }
      }
    }

    expect(completion.completion.requestId).toBe("req-1")
    expect(completion.completion.ok).toBe(true)
    expect(completion.completion.response).toEqual(expect.objectContaining({
      projectId: "wiki-test",
      query: "GPU memory bandwidth optimization for attention",
      warning: null,
      results: expect.arrayContaining([
        expect.objectContaining({
          title: "Flash Attention",
          relativePath: "concepts/flash-attention.md",
        }),
      ]),
    }))
    expect(completion.completion.response).not.toHaveProperty("pages")

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

  it("returns wiki-relative search paths and respects the requested limit", async () => {
    const projectPath = await writeProject({
      "purpose.md": "# Purpose\nAnswer from the wiki.",
      "schema.md": "# Schema\n",
      "wiki/index.md": "# Index\n- [[attention-notes]]\n- [[attention-backlog]]\n",
      "wiki/sources/gpu/attention-notes.md":
        "# Attention Notes\n\nChainable nested relative path result.",
      "wiki/concepts/attention-backlog.md":
        "# Attention Backlog\n\nA second matching page to prove the limit is applied.",
    })

    mockSearchByEmbedding.mockResolvedValueOnce([])

    const stop = await startMcpRetrievalBridge()
    const handler = listeners.get(MCP_RETRIEVAL_REQUEST_EVENT)

    await handler?.({
      payload: {
        requestId: "req-relative-path",
        projectId: "wiki-test",
        projectPath,
        query: "Chainable nested relative path result",
        limit: 1,
      },
    })

    const completion = mockInvoke.mock.calls[0]?.[1] as {
      completion: {
        response: {
          results: Array<{
            title: string
            relativePath: string
          }>
        }
      }
    }

    expect(completion.completion.response.results).toHaveLength(1)
    expect(completion.completion.response.results[0]).toEqual(expect.objectContaining({
      title: "Attention Notes",
      relativePath: "sources/gpu/attention-notes.md",
    }))

    stop()
  })
})
