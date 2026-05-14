import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  files,
  mockCaption,
  mockExtractImages,
  mockListDirectory,
  mockReadBase64,
  pendingResponses,
} = vi.hoisted(() => ({
  files: new Map<string, string>(),
  mockCaption: vi.fn(),
  mockExtractImages: vi.fn(),
  mockListDirectory: vi.fn(),
  mockReadBase64: vi.fn(),
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
  readFileAsBase64: (...args: unknown[]) => mockReadBase64(...args),
}))

vi.mock("@/lib/vision-caption", () => ({
  captionImage: (...args: unknown[]) => mockCaption(...args),
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
  }
})

import { autoIngest } from "./ingest"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"

const PROJECT = "/project"
const SOURCE_STEM = "望城区“智慧低空” 政务场景应用服务项目建设方案 V1"
const SOURCE_NAME = `${SOURCE_STEM}.docx`
const SOURCE_PATH = `${PROJECT}/raw/sources/${SOURCE_NAME}`
const IMAGE_REL_PATH = `media/${SOURCE_STEM}/img-7.png`
const IMAGE_ABS_PATH = `${PROJECT}/wiki/${IMAGE_REL_PATH}`
const ENCODED_IMAGE_REL_PATH = `media/${encodeURIComponent(SOURCE_STEM)}/img-7.png`

const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "gpt-4o-mini",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
}

async function sha256OfBase64(b64: string): Promise<string> {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

beforeEach(() => {
  files.clear()
  pendingResponses.length = 0
  mockCaption.mockReset()
  mockExtractImages.mockReset()
  mockListDirectory.mockReset()
  mockReadBase64.mockReset()
  mockListDirectory.mockResolvedValue([])
  mockReadBase64.mockImplementation(async (path: string) => {
    if (path.includes("%")) throw new Error(`path must be decoded before reading: ${path}`)
    if (!path.endsWith("/img-7.png")) throw new Error(`missing image: ${path}`)
    return { base64: "AAAA", mimeType: "image/png" }
  })

  files.set(
    SOURCE_PATH,
    "这是 DOCX 抽取出的正文，没有任何 markdown 图片引用。",
  )
  files.set(`${PROJECT}/schema.md`, "")
  files.set(`${PROJECT}/purpose.md`, "")
  files.set(`${PROJECT}/wiki/index.md`, "")
  files.set(`${PROJECT}/wiki/overview.md`, "")

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
    outputLanguage: "auto",
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

describe("autoIngest image captioning", () => {
  it("captions extracted DOCX images even when source text has no inline image markdown", async () => {
    const imageHash = await sha256OfBase64("AAAA")
    mockExtractImages.mockResolvedValue([
      {
        index: 7,
        mimeType: "image/png",
        page: null,
        width: 1280,
        height: 720,
        relPath: IMAGE_REL_PATH,
        absPath: IMAGE_ABS_PATH,
        sha256: imageHash,
      },
    ])
    mockCaption.mockResolvedValue("图片展示望城区智慧低空政务场景应用服务项目的建设方案图示。")
    pendingResponses.push(
      "源文档分析。",
      [
        `---FILE: wiki/sources/${SOURCE_STEM}.md---`,
        "---",
        "type: source",
        `title: "Source: ${SOURCE_NAME}"`,
        "created: 2026-05-07",
        "updated: 2026-05-07",
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
    expect(mockCaption).toHaveBeenCalledOnce()
    expect(summary).toContain(
      `![图片展示望城区智慧低空政务场景应用服务项目的建设方案图示。](${ENCODED_IMAGE_REL_PATH})`,
    )
    expect(summary).not.toContain(`![](${ENCODED_IMAGE_REL_PATH})`)
  })

  it("uses extracted DOCX image context when captioning saved-image fallbacks", async () => {
    const imageHash = await sha256OfBase64("AAAA")
    mockExtractImages.mockResolvedValue([
      {
        index: 7,
        mimeType: "image/png",
        page: null,
        width: 1280,
        height: 720,
        relPath: IMAGE_REL_PATH,
        absPath: IMAGE_ABS_PATH,
        sha256: imageHash,
        contextBefore: "本图前文说明这是智慧低空政务场景的总体架构。",
        contextAfter: "图后文字说明平台包括感知、调度和服务应用三层。",
      },
    ])
    mockCaption.mockResolvedValue("图片展示智慧低空政务场景的总体架构。")
    pendingResponses.push(
      "源文档分析。",
      [
        `---FILE: wiki/sources/${SOURCE_STEM}.md---`,
        "---",
        "type: source",
        `title: "Source: ${SOURCE_NAME}"`,
        "created: 2026-05-07",
        "updated: 2026-05-07",
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

    const opts = mockCaption.mock.calls[0][4] as {
      contextBefore: string
      contextAfter: string
      outputLanguage: string
    }
    expect(opts.contextBefore).toContain("智慧低空政务场景")
    expect(opts.contextAfter).toContain("感知、调度和服务应用三层")
    expect(opts.outputLanguage).toBe("Chinese")
  })

  it("uses inline encoded absolute image refs in sourceContent before falling back to saved-image context", async () => {
    const imageHash = await sha256OfBase64("AAAA")
    const fallbackBefore = "fallback-before should not be used"
    const fallbackAfter = "fallback-after should not be used"
    mockExtractImages.mockResolvedValue([
      {
        index: 7,
        mimeType: "image/png",
        page: null,
        width: 1280,
        height: 720,
        relPath: IMAGE_REL_PATH,
        absPath: IMAGE_ABS_PATH,
        sha256: imageHash,
        contextBefore: fallbackBefore,
        contextAfter: fallbackAfter,
      },
    ])
    mockCaption.mockResolvedValue("图片展示望城区智慧低空政务场景应用服务项目的建设方案图示。")
    files.set(
      SOURCE_PATH,
      [
        "inline-before 这是正文里紧邻图片的上文。",
        `![](${PROJECT}/wiki/${ENCODED_IMAGE_REL_PATH})`,
        "inline-after 这是正文里紧邻图片的下文。",
      ].join("\n"),
    )
    pendingResponses.push(
      "源文档分析。",
      [
        `---FILE: wiki/sources/${SOURCE_STEM}.md---`,
        "---",
        "type: source",
        `title: "Source: ${SOURCE_NAME}"`,
        "created: 2026-05-07",
        "updated: 2026-05-07",
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

    expect(mockCaption).toHaveBeenCalledOnce()
    expect(mockReadBase64).toHaveBeenCalledWith(IMAGE_ABS_PATH)
    const opts = mockCaption.mock.calls[0][4] as {
      contextBefore: string
      contextAfter: string
    }
    expect(opts.contextBefore).toContain("inline-before")
    expect(opts.contextAfter).toContain("inline-after")
    expect(opts.contextBefore).not.toContain(fallbackBefore)
    expect(opts.contextAfter).not.toContain(fallbackAfter)
  })

  it("recaptions stale-language image cache entries before injecting source-summary images", async () => {
    const imageHash = await sha256OfBase64("AAAA")
    mockExtractImages.mockResolvedValue([
      {
        index: 7,
        mimeType: "image/png",
        page: null,
        width: 1280,
        height: 720,
        relPath: IMAGE_REL_PATH,
        absPath: IMAGE_ABS_PATH,
        sha256: imageHash,
        contextBefore: "本图前文说明这是智慧低空政务场景的总体架构。",
        contextAfter: "图后文字说明平台包括感知、调度和服务应用三层。",
      },
    ])
    files.set(
      `${PROJECT}/.llm-wiki/image-caption-cache.json`,
      JSON.stringify({
        [imageHash]: {
          caption: "English architecture diagram description",
          mimeType: "image/png",
          model: "vl-old",
          outputLanguage: "English",
          capturedAt: "2026-01-01T00:00:00Z",
        },
      }),
    )
    useWikiStore.setState({ outputLanguage: "Chinese" })
    mockCaption.mockResolvedValue("图片展示智慧低空政务场景的总体架构。")
    pendingResponses.push(
      "源文档分析。",
      [
        `---FILE: wiki/sources/${SOURCE_STEM}.md---`,
        "---",
        "type: source",
        `title: "Source: ${SOURCE_NAME}"`,
        "created: 2026-05-07",
        "updated: 2026-05-07",
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

    expect(mockCaption).toHaveBeenCalledOnce()
    const summary = files.get(`${PROJECT}/wiki/sources/${SOURCE_STEM}.md`) ?? ""
    expect(summary).toContain(
      `![图片展示智慧低空政务场景的总体架构。](${ENCODED_IMAGE_REL_PATH})`,
    )
    expect(summary).not.toContain("English architecture diagram description")
  })
})
