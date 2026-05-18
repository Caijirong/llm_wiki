import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DocumentManualVisualOccurrence } from "./document-manual-visuals"

const {
  files,
  mockExtractImages,
  mockExtractManualVisuals,
  mockListDirectory,
  mockGetProjectKind,
  mockReadFileAsBase64,
  pendingResponses,
} = vi.hoisted(() => ({
  files: new Map<string, string>(),
  mockExtractImages: vi.fn(),
  mockExtractManualVisuals: vi.fn(),
  mockListDirectory: vi.fn(),
  mockGetProjectKind: vi.fn(),
  mockReadFileAsBase64: vi.fn(async (_path?: string) => ({
    base64: "iVBORw0KGgo=",
    mimeType: "image/png",
  })),
  pendingResponses: [] as string[],
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    const content = files.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    files.set(path, content)
  }),
  createDirectory: vi.fn(async () => {}),
  fileExists: vi.fn(async (path: string) => files.has(path)),
  listDirectory: (...args: unknown[]) => mockListDirectory(...args),
  readFileAsBase64: vi.fn(async (path: string) => mockReadFileAsBase64(path)),
}))

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, _messages, callbacks) => {
    const response = pendingResponses.shift() ?? ""
    callbacks.onToken(response)
    callbacks.onDone()
  }),
}))

vi.mock("./extract-source-images", async () => {
  const actual = await vi.importActual<typeof import("./extract-source-images")>(
    "./extract-source-images",
  )
  return {
    ...actual,
    extractAndSaveSourceImages: (...args: unknown[]) => mockExtractImages(...args),
    extractAndSaveDocumentManualDocxVisuals: (...args: unknown[]) =>
      mockExtractManualVisuals(...args),
  }
})

vi.mock("./image-caption-pipeline", () => ({
  captionMarkdownImages: vi.fn(async (_projectPath, markdown: string) => ({
    enrichedMarkdown: markdown,
    freshCaptions: 0,
    cachedCaptions: 0,
    failed: 0,
  })),
  loadCaptionCache: vi.fn(async () => new Map()),
}))

vi.mock("./project-identity", async () => {
  const actual = await vi.importActual<typeof import("./project-identity")>(
    "./project-identity",
  )
  return {
    ...actual,
    getProjectKind: (...args: unknown[]) => mockGetProjectKind(...args),
  }
})

import { autoIngest } from "./ingest"
import { saveIngestCache } from "./ingest-cache"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"

const PROJECT = "/project"
const SOURCE_STEM = "operator-manual"
const SOURCE_NAME = `${SOURCE_STEM}.docx`
const SOURCE_PATH = `${PROJECT}/raw/sources/${SOURCE_NAME}`

function makeSourceContent(): string {
  return [
    "# 运行界面",
    "",
    "设备连接状态说明",
    "",
    "| 图标 | 图标描述 |",
    "| --- | --- |",
    "| ![](media/operator-manual/img-1.png) | 未连接 |",
    "| ![](media/operator-manual/img-2.png) | 连接中 |",
    "| ![](media/operator-manual/img-3.png) | 已连接 |",
    "",
    "表格结束后的说明段落。",
  ].join("\n")
}

const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "gpt-4o-mini",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
}

function makeOccurrence(
  overrides: Partial<DocumentManualVisualOccurrence>,
): DocumentManualVisualOccurrence {
  return {
    occurrenceIndex: 1,
    relPath: "media/operator-manual/img-1.png",
    absPath: "/project/wiki/media/operator-manual/img-1.png",
    mimeType: "image/png",
    width: 32,
    height: 32,
    sha256: "sha-1",
    visualClass: "small_visual",
    docOrder: 1,
    sectionTitle: "运行界面",
    containerKind: "table_cell",
    tableId: 1,
    rowIndex: 1,
    colIndex: 0,
    headingPath: ["运行界面"],
    rowText: "",
    cellText: "",
    rowHeaderText: "图标",
    tableTextSnapshot: "图标 图标描述 未连接 连接中 已连接",
    precedingParagraph: "设备连接状态说明",
    followingParagraph: "表格结束后的说明段落。",
    rowImageCount: 1,
    tableImageCount: 3,
    tableRowCount: 4,
    tableColCount: 2,
    localTextBefore: "",
    localTextAfter: "",
    contextBefore: "设备连接状态说明",
    contextAfter: "",
    ...overrides,
  }
}

beforeEach(() => {
  files.clear()
  pendingResponses.length = 0
  mockExtractImages.mockReset()
  mockExtractManualVisuals.mockReset()
  mockListDirectory.mockReset()
  mockGetProjectKind.mockReset()
  mockReadFileAsBase64.mockClear()

  files.set(SOURCE_PATH, makeSourceContent())
  files.set(`${PROJECT}/schema.md`, "")
  files.set(`${PROJECT}/purpose.md`, "")
  files.set(`${PROJECT}/wiki/index.md`, "")
  files.set(`${PROJECT}/wiki/overview.md`, "")

  mockListDirectory.mockResolvedValue([])
  mockExtractImages.mockResolvedValue([])
  mockGetProjectKind.mockResolvedValue("document-manual")

  useWikiStore.setState({
    llmConfig,
    embeddingConfig: {
      enabled: false,
      endpoint: "",
      apiKey: "",
      model: "",
    },
    multimodalConfig: {
      enabled: true,
      useMainLlm: false,
      provider: "custom",
      apiKey: "",
      model: "vl-test",
      ollamaUrl: "",
      customEndpoint: "http://localhost:1234/v1",
      apiMode: "chat_completions",
      concurrency: 2,
    },
    outputLanguage: "Chinese",
  })
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
  useChatStore.setState({
    conversations: [],
    messages: [],
    activeConversationId: null,
    mode: "chat",
    ingestSource: null,
    isStreaming: false,
    streamingContent: "",
  })
})

describe("autoIngest document-manual DOCX visuals", () => {
  it("writes a grouped UI Visual Elements section for small visuals", async () => {
    mockExtractManualVisuals.mockResolvedValue([
      makeOccurrence({
        occurrenceIndex: 1,
        docOrder: 1,
        sha256: "sha-offline",
        relPath: "media/operator-manual/img-1.png",
        absPath: "/project/wiki/media/operator-manual/img-1.png",
        containerKind: "table_cell",
        tableId: 1,
        rowIndex: 1,
        colIndex: 0,
        rowText: "未连接",
        cellText: "未连接",
        rowHeaderText: "图标含义",
        tableTextSnapshot: "图标 含义 未连接 连接中 已连接",
        tableImageCount: 4,
        tableRowCount: 4,
        tableColCount: 2,
      }),
      makeOccurrence({
        occurrenceIndex: 2,
        docOrder: 2,
        sha256: "sha-loading",
        relPath: "media/operator-manual/img-2.png",
        absPath: "/project/wiki/media/operator-manual/img-2.png",
        containerKind: "table_cell",
        tableId: 1,
        rowIndex: 2,
        colIndex: 0,
        rowText: "连接中",
        cellText: "连接中",
        rowHeaderText: "图标含义",
        tableTextSnapshot: "图标 含义 未连接 连接中 已连接",
        tableImageCount: 4,
        tableRowCount: 4,
        tableColCount: 2,
      }),
      makeOccurrence({
        occurrenceIndex: 3,
        docOrder: 3,
        sha256: "sha-online",
        relPath: "media/operator-manual/img-3.png",
        absPath: "/project/wiki/media/operator-manual/img-3.png",
        containerKind: "table_cell",
        tableId: 1,
        rowIndex: 3,
        colIndex: 0,
        rowText: "已连接",
        cellText: "已连接",
        rowHeaderText: "图标含义",
        tableTextSnapshot: "图标 含义 未连接 连接中 已连接",
        tableImageCount: 4,
        tableRowCount: 4,
        tableColCount: 2,
      }),
      makeOccurrence({
        occurrenceIndex: 4,
        docOrder: 4,
        sha256: "sha-online",
        relPath: "media/operator-manual/img-3.png",
        absPath: "/project/wiki/media/operator-manual/img-3.png",
        containerKind: "table_cell",
        tableId: 1,
        rowIndex: 3,
        colIndex: 0,
        rowText: "已连接",
        cellText: "已连接",
        rowHeaderText: "图标含义",
        tableTextSnapshot: "图标 含义 未连接 连接中 已连接",
        tableImageCount: 4,
        tableRowCount: 4,
        tableColCount: 2,
      }),
    ])
    pendingResponses.push(
      "源文档分析。",
      [
        `---FILE: wiki/sources/${SOURCE_STEM}.md---`,
        "---",
        "type: source",
        `title: "Source: ${SOURCE_NAME}"`,
        "created: 2026-05-15",
        "updated: 2026-05-15",
        `sources: ["${SOURCE_NAME}"]`,
        "tags: []",
        "related: []",
        "---",
        "",
        `# Source: ${SOURCE_NAME}`,
        "",
        "正文摘要。",
        "---END FILE---",
      ].join("\n"),
      '{"groupTitle":"Device Status","groupSummary":"展示设备未连接、连接中与已连接三种状态。","confidence":0.9}',
    )

    await autoIngest(PROJECT, SOURCE_PATH, llmConfig)

    const summary = files.get(`${PROJECT}/wiki/sources/${SOURCE_STEM}.md`) ?? ""
    expect(mockExtractManualVisuals).toHaveBeenCalledWith(PROJECT, SOURCE_PATH)
    expect(summary).toContain("## UI Visual Elements")
    expect(summary).toContain("```llm-wiki-visual-group")
    expect(summary).toContain("title: Device Status")
    expect(summary).not.toContain("| 图标 | 图标描述 |")
    expect(summary).toContain("image: media/operator-manual/img-1.png")
    expect(summary).toContain("description: 未连接")
    expect(summary).toContain("image: media/operator-manual/img-3.png")
  })

  it("does not write UI Visual Elements when multimodal is disabled", async () => {
    useWikiStore.setState({
      multimodalConfig: {
        enabled: false,
        useMainLlm: false,
        provider: "custom",
        apiKey: "",
        model: "vl-test",
        ollamaUrl: "",
        customEndpoint: "http://localhost:1234/v1",
        apiMode: "chat_completions",
        concurrency: 2,
      },
    })
    mockExtractManualVisuals.mockResolvedValue([
      makeOccurrence({
        rowText: "未连接",
      }),
    ])
    pendingResponses.push(
      "源文档分析。",
      [
        `---FILE: wiki/sources/${SOURCE_STEM}.md---`,
        "---",
        "type: source",
        `title: "Source: ${SOURCE_NAME}"`,
        "created: 2026-05-15",
        "updated: 2026-05-15",
        `sources: ["${SOURCE_NAME}"]`,
        "tags: []",
        "related: []",
        "---",
        "",
        `# Source: ${SOURCE_NAME}`,
        "",
        "正文摘要。",
        "---END FILE---",
      ].join("\n"),
    )

    await autoIngest(PROJECT, SOURCE_PATH, llmConfig)

    const summary = files.get(`${PROJECT}/wiki/sources/${SOURCE_STEM}.md`) ?? ""
    expect(summary).not.toContain("## UI Visual Elements")
  })

  it("keeps cache-hit manual DOCX ingest group-aware without flattening small visuals", async () => {
    const sourceSummaryPath = `${PROJECT}/wiki/sources/${SOURCE_STEM}.md`
    files.set(
      sourceSummaryPath,
      [
        "---",
        "type: source",
        `title: "Source: ${SOURCE_NAME}"`,
        "created: 2026-05-15",
        "updated: 2026-05-15",
        `sources: ["${SOURCE_NAME}"]`,
        "tags: []",
        "related: []",
        "---",
        "",
        `# Source: ${SOURCE_NAME}`,
        "",
        "正文摘要。",
      ].join("\n"),
    )
    await saveIngestCache(PROJECT, SOURCE_NAME, makeSourceContent(), [
      `wiki/sources/${SOURCE_STEM}.md`,
    ])
    mockExtractManualVisuals.mockResolvedValue([
      makeOccurrence({
        occurrenceIndex: 1,
        docOrder: 1,
        sha256: "sha-offline",
        relPath: "media/operator-manual/img-1.png",
        absPath: "/project/wiki/media/operator-manual/img-1.png",
        containerKind: "table_cell",
        tableId: 1,
        rowIndex: 1,
        colIndex: 0,
        rowText: "未连接",
        cellText: "未连接",
        rowHeaderText: "图标含义",
        tableTextSnapshot: "图标 含义 未连接 连接中",
        tableImageCount: 2,
        tableRowCount: 3,
        tableColCount: 2,
      }),
      makeOccurrence({
        occurrenceIndex: 2,
        docOrder: 2,
        sha256: "sha-loading",
        relPath: "media/operator-manual/img-2.png",
        absPath: "/project/wiki/media/operator-manual/img-2.png",
        containerKind: "table_cell",
        tableId: 1,
        rowIndex: 2,
        colIndex: 0,
        rowText: "连接中",
        cellText: "连接中",
        rowHeaderText: "图标含义",
        tableTextSnapshot: "图标 含义 未连接 连接中",
        tableImageCount: 2,
        tableRowCount: 3,
        tableColCount: 2,
      }),
    ])
    pendingResponses.push(
      '{"groupTitle":"Device Status","groupSummary":"展示设备未连接与连接中两种状态。","confidence":0.88}',
    )

    await autoIngest(PROJECT, SOURCE_PATH, llmConfig)

    const summary = files.get(sourceSummaryPath) ?? ""
    expect(mockExtractImages).not.toHaveBeenCalled()
    expect(mockExtractManualVisuals).toHaveBeenCalledWith(PROJECT, SOURCE_PATH)
    expect(summary).toContain("## UI Visual Elements")
    expect(summary).toContain("```llm-wiki-visual-group")
    expect(summary).toContain("title: Device Status")
    expect(summary).not.toContain("| 图标 | 图标描述 |")
    expect(summary).not.toContain("## Embedded Images")
  })

  it("keeps regular visuals in Embedded Images instead of UI Visual Elements", async () => {
    mockExtractManualVisuals.mockResolvedValue([
      makeOccurrence({
        occurrenceIndex: 1,
        visualClass: "regular_visual",
        width: 640,
        height: 360,
        containerKind: "paragraph",
        tableId: null,
        rowIndex: null,
        colIndex: null,
        rowHeaderText: "",
        tableTextSnapshot: "",
        rowImageCount: 0,
        tableImageCount: 0,
        tableRowCount: 0,
        tableColCount: 0,
        relPath: "media/operator-manual/screen-1.png",
        absPath: "/project/wiki/media/operator-manual/screen-1.png",
        sha256: "sha-screen",
        rowText: "",
        cellText: "",
        contextBefore: "司机显示界面总览",
        contextAfter: "界面包含速度、模式与告警区域",
      }),
    ])
    pendingResponses.push(
      "源文档分析。",
      [
        `---FILE: wiki/sources/${SOURCE_STEM}.md---`,
        "---",
        "type: source",
        `title: "Source: ${SOURCE_NAME}"`,
        "created: 2026-05-15",
        "updated: 2026-05-15",
        `sources: ["${SOURCE_NAME}"]`,
        "tags: []",
        "related: []",
        "---",
        "",
        `# Source: ${SOURCE_NAME}`,
        "",
        "正文摘要。",
        "---END FILE---",
      ].join("\n"),
    )

    await autoIngest(PROJECT, SOURCE_PATH, llmConfig)

    const summary = files.get(`${PROJECT}/wiki/sources/${SOURCE_STEM}.md`) ?? ""
    expect(summary).toContain("## Embedded Images")
    expect(summary).toContain("media/operator-manual/screen-1.png")
    expect(summary).not.toContain("## UI Visual Elements")
  })

  it("surfaces UI visual processing progress and avoids per-icon vision calls when row text is sufficient", async () => {
    mockExtractManualVisuals.mockResolvedValue([
      makeOccurrence({
        occurrenceIndex: 1,
        docOrder: 1,
        sha256: "sha-offline",
        relPath: "media/operator-manual/img-1.png",
        absPath: "/project/wiki/media/operator-manual/img-1.png",
        containerKind: "table_cell",
        tableId: 1,
        rowIndex: 1,
        colIndex: 0,
        rowText: "未连接",
        cellText: "未连接",
        rowHeaderText: "图标含义",
        tableTextSnapshot: "图标 含义 未连接 连接中",
        tableImageCount: 2,
        tableRowCount: 3,
        tableColCount: 2,
      }),
      makeOccurrence({
        occurrenceIndex: 2,
        docOrder: 2,
        sha256: "sha-loading",
        relPath: "media/operator-manual/img-2.png",
        absPath: "/project/wiki/media/operator-manual/img-2.png",
        containerKind: "table_cell",
        tableId: 1,
        rowIndex: 2,
        colIndex: 0,
        rowText: "连接中",
        cellText: "连接中",
        rowHeaderText: "图标含义",
        tableTextSnapshot: "图标 含义 未连接 连接中",
        tableImageCount: 2,
        tableRowCount: 3,
        tableColCount: 2,
      }),
    ])
    pendingResponses.push(
      "源文档分析。",
      [
        `---FILE: wiki/sources/${SOURCE_STEM}.md---`,
        "---",
        "type: source",
        `title: "Source: ${SOURCE_NAME}"`,
        "created: 2026-05-15",
        "updated: 2026-05-15",
        `sources: ["${SOURCE_NAME}"]`,
        "tags: []",
        "related: []",
        "---",
        "",
        `# Source: ${SOURCE_NAME}`,
        "",
        "正文摘要。",
        "---END FILE---",
      ].join("\n"),
      '{"groupTitle":"Device Status","groupSummary":"展示设备未连接与连接中两种状态。","confidence":0.9}',
    )

    await autoIngest(PROJECT, SOURCE_PATH, llmConfig)

    expect(mockReadFileAsBase64).not.toHaveBeenCalled()
    const ingestActivity = useActivityStore.getState().items.find((item) => item.title === SOURCE_NAME)
    expect(ingestActivity?.detail).toBe("1 files written")
    const summary = files.get(`${PROJECT}/wiki/sources/${SOURCE_STEM}.md`) ?? ""
    expect(summary).toContain("title: Device Status")
    expect(summary).not.toContain("### Device Status")
  })
})
