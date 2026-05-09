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
import {
  formatKnowledgeImageMarkdown,
  formatKnowledgeImagePromptContext,
  renderAnswerWithKnowledgeImages,
} from "./chat-retrieval"
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

  it("surfaces matching images as renderable knowledge results", async () => {
    const projectPath = await writeProject({
      "purpose.md": "# Purpose\n",
      "schema.md": "# Schema\n",
      "wiki/index.md": "# Index\n",
      "wiki/sources/project-plan.md": [
        "---",
        "title: Project Plan",
        "type: source",
        "---",
        "",
        "# Project Plan",
        "",
        "低空政务平台说明。",
        "",
        "![智慧低空政务场景总体架构图，包含感知、调度和服务应用三层。](media/project-plan/img-7.png)",
      ].join("\n"),
    })

    mockSearchByEmbedding.mockResolvedValueOnce([])

    const context = await buildChatRetrievalContext({
      projectPath,
      query: "智慧低空政务场景总体架构图",
      maxContextSize: 40_000,
    })

    expect(context.knowledgeImages).toEqual([
      {
        url: "media/project-plan/img-7.png",
        alt: "智慧低空政务场景总体架构图，包含感知、调度和服务应用三层。",
        sourceTitle: "Project Plan",
        sourcePath: "wiki/sources/project-plan.md",
      },
    ])
    expect(formatKnowledgeImageMarkdown(context.knowledgeImages)).toContain(
      "![智慧低空政务场景总体架构图，包含感知、调度和服务应用三层。](media/project-plan/img-7.png)",
    )
  })

  it("keeps an exact image-alt source hit even when vector results rank concept pages first", async () => {
    const projectPath = await writeProject({
      "purpose.md": "# Purpose\n",
      "schema.md": "# Schema\n",
      "wiki/index.md": "# Index\n",
      "wiki/sources/project-plan.md": [
        "---",
        "title: Project Plan",
        "type: source",
        "---",
        "",
        "# Project Plan",
        "",
        "![望城区智慧低空项目封面图，画面中有多架无人机在城市上空飞行。](media/project-plan/img-1.png)",
        "",
        "![图 3.2-5 无人机采集作业流程图。该流程图展示无人机数据采集的完整步骤。](media/project-plan/img-2.png)",
      ].join("\n"),
      "wiki/concepts/drone-ops.md": [
        "---",
        "title: 无人机作业",
        "type: concept",
        "---",
        "",
        "# 无人机作业",
        "",
        "无人机作业涉及采集、流程、数据处理和业务闭环。",
      ].join("\n"),
    })

    mockSearchByEmbedding.mockResolvedValueOnce([
      { id: "drone-ops", score: 0.98 },
      { id: "project-plan", score: 0.2 },
    ])

    const context = await buildChatRetrievalContext({
      projectPath,
      query: "无人机采集作业流程图",
      maxContextSize: 40_000,
      searchLimit: 1,
    })

    expect(context.knowledgeImages[0]).toEqual({
      url: "media/project-plan/img-2.png",
      alt: "图 3.2-5 无人机采集作业流程图。该流程图展示无人机数据采集的完整步骤。",
      sourceTitle: "Project Plan",
      sourcePath: "wiki/sources/project-plan.md",
    })
    expect(context.knowledgeImages[1]?.url).toBe("media/project-plan/img-1.png")
    expect(context.pages.map((page) => page.path)).toContain(
      "wiki/sources/project-plan.md",
    )
    expect(context.pages.map((page) => page.path)).toEqual([
      "wiki/sources/project-plan.md",
      "wiki/concepts/drone-ops.md",
    ])
    expect(context.references.map((ref) => ref.path)).toEqual([
      "wiki/sources/project-plan.md",
      "wiki/concepts/drone-ops.md",
    ])
  })

  it("formats knowledge images for the llm with stable image ids", () => {
    const promptContext = formatKnowledgeImagePromptContext([
      {
        url: "media/project-plan/img-7.png",
        alt: "智慧低空政务场景总体架构图，包含感知、调度和服务应用三层。",
        sourceTitle: "Project Plan",
        sourcePath: "wiki/sources/project-plan.md",
      },
    ])

    expect(promptContext).toContain("Image 1")
    expect(promptContext).toContain("Use this image only by inserting [[image:1]]")
    expect(promptContext).toContain("智慧低空政务场景总体架构图")
    expect(promptContext).not.toContain("![")
  })

  it("renders referenced images inline at marker positions", () => {
    const answer = renderAnswerWithKnowledgeImages(
      [
        "无人机采集通常分为准备、航线规划、现场采集和数据回传四个阶段。",
        "",
        "[[image:1]]",
        "",
        "现场采集阶段需要重点关注重叠率与异常补拍。",
      ].join("\n"),
      [
        {
          url: "media/project-plan/img-2.png",
          alt: "图 3.2-5 无人机采集作业流程图。该流程图展示无人机数据采集的完整步骤。",
          sourceTitle: "Project Plan",
          sourcePath: "wiki/sources/project-plan.md",
        },
      ],
    )

    expect(answer).toContain("![图 3.2-5 无人机采集作业流程图。该流程图展示无人机数据采集的完整步骤。](media/project-plan/img-2.png)")
    expect(answer).toContain("*图 3.2-5 无人机采集作业流程图*")
    expect(answer).not.toContain("[[image:1]]")
    expect(answer).not.toContain("## Related Images")
  })

  it("ignores duplicate image references and does not append unused images when one image is inserted inline", () => {
    const answer = renderAnswerWithKnowledgeImages(
      [
        "第一段解释总体流程。",
        "",
        "[[image:1]]",
        "",
        "第二段继续解释同一张图。",
        "",
        "[[image:1]]",
      ].join("\n"),
      [
        {
          url: "media/project-plan/img-2.png",
          alt: "图 3.2-5 无人机采集作业流程图。该流程图展示无人机数据采集的完整步骤。",
          sourceTitle: "Project Plan",
          sourcePath: "wiki/sources/project-plan.md",
        },
        {
          url: "media/project-plan/img-3.png",
          alt: "图 3.2-6 数据回传链路图。",
          sourceTitle: "Project Plan",
          sourcePath: "wiki/sources/project-plan.md",
        },
      ],
    )

    expect(answer.match(/media\/project-plan\/img-2\.png/g)).toHaveLength(1)
    expect(answer).not.toContain("[[image:1]]")
    expect(answer).not.toContain("## Related Images")
    expect(answer).not.toContain("media/project-plan/img-3.png")
  })

  it("falls back to a related images section when the llm emits no valid image markers", () => {
    const answer = renderAnswerWithKnowledgeImages(
      "该流程图展示了无人机采集的完整步骤。",
      [
        {
          url: "media/project-plan/img-2.png",
          alt: "图 3.2-5 无人机采集作业流程图。该流程图展示无人机数据采集的完整步骤。",
          sourceTitle: "Project Plan",
          sourcePath: "wiki/sources/project-plan.md",
        },
      ],
    )

    expect(answer).toContain("## Related Images")
    expect(answer).toContain("media/project-plan/img-2.png")
  })

  it("uses the image description instead of the source page title as the image heading", () => {
    const imageMarkdown = formatKnowledgeImageMarkdown([
      {
        url: "media/project-plan/img-2.png",
        alt: "图 3.2-5 无人机采集作业流程图。该流程图展示无人机数据采集的完整步骤。",
        sourceTitle: "望城区“智慧低空”政务场景应用服务项目建设方案",
        sourcePath: "wiki/sources/project-plan.md",
      },
    ])

    expect(imageMarkdown).toContain("### Image 1: 图 3.2-5 无人机采集作业流程图")
    expect(imageMarkdown).not.toContain(
      "### Image 1: 望城区“智慧低空”政务场景应用服务项目建设方案",
    )
  })
})
