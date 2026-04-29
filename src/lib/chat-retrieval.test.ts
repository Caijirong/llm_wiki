import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import path from "node:path"
import fs from "node:fs/promises"
import { realFs, createTempProject } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

const mockSearchByEmbedding =
  vi.fn<(...args: unknown[]) => Promise<Array<{ id: string; score: number }>>>()

vi.mock("./embedding", () => ({
  searchByEmbedding: (...args: unknown[]) => mockSearchByEmbedding(...args),
}))

import { buildChatRetrievalContext } from "./chat-retrieval"
import { clearGraphCache } from "./graph-relevance"
import { useWikiStore } from "@/stores/wiki-store"

let tmp: { path: string; cleanup: () => Promise<void> } | undefined

async function writeProject(files: Record<string, string>): Promise<string> {
  tmp = await createTempProject("chat-retrieval")
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmp.path, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, "utf-8")
  }
  return tmp.path
}

beforeEach(() => {
  clearGraphCache()
  mockSearchByEmbedding.mockReset()
  useWikiStore.getState().setEmbeddingConfig({
    enabled: true,
    endpoint: "http://test/v1/embeddings",
    apiKey: "",
    model: "test-embed",
  })
})

afterEach(async () => {
  clearGraphCache()
  if (tmp) {
    await tmp.cleanup()
    tmp = undefined
  }
})

describe("buildChatRetrievalContext", () => {
  it("uses the same hybrid search results that chat uses for vector-only matches", async () => {
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

    const context = await buildChatRetrievalContext({
      projectPath,
      query: "GPU memory bandwidth optimization for attention",
      maxContextSize: 40_000,
    })

    expect(context.searchResults[0]?.title).toBe("Flash Attention")
    expect(context.pages[0]?.title).toBe("Flash Attention")
    expect(context.pageList).toContain("Flash Attention")
    expect(context.pagesContext).toContain("IO-aware tiled attention")
  })

  it("applies graph expansion and page limits using the chat retrieval ordering", async () => {
    const projectPath = await writeProject({
      "purpose.md": "# Purpose\n",
      "schema.md": "# Schema\n",
      "wiki/index.md": "# Index\n",
      "wiki/concepts/alpha.md":
        "---\ntitle: Alpha\ntype: concept\nsources: [shared.pdf]\n---\n\n# Alpha\n\nalpha topic links to [[beta]].",
      "wiki/concepts/beta.md":
        "---\ntitle: Beta\ntype: concept\nsources: [shared.pdf]\n---\n\n# Beta\n\nbeta expansion content.",
    })

    mockSearchByEmbedding.mockResolvedValueOnce([])

    const context = await buildChatRetrievalContext({
      projectPath,
      query: "alpha",
      maxContextSize: 40_000,
      maxPages: 2,
    })

    expect(context.pages.map((page) => page.title)).toEqual(["Alpha", "Beta"])
    expect(context.references).toEqual([
      { title: "Alpha", path: "wiki/concepts/alpha.md" },
      { title: "Beta", path: "wiki/concepts/beta.md" },
    ])
  })
})
