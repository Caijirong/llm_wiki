import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  files,
  mockListDirectory,
  mockStreamChat,
} = vi.hoisted(() => ({
  files: new Map<string, string>(),
  mockListDirectory: vi.fn(),
  mockStreamChat: vi.fn(),
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
  readFileAsBase64: vi.fn(),
}))

vi.mock("./llm-client", () => ({
  streamChat: (...args: unknown[]) => mockStreamChat(...args),
}))

vi.mock("./extract-source-images", () => ({
  extractAndSaveSourceImages: vi.fn(async () => []),
  buildImageMarkdownSection: vi.fn(() => ""),
}))

import { autoIngest } from "./ingest"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"

const PROJECT = "/project"
const SOURCE_NAME = "legacy-source.doc"
const SOURCE_PATH = `${PROJECT}/raw/sources/${SOURCE_NAME}`

const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "gpt-4o-mini",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
}

beforeEach(() => {
  files.clear()
  mockListDirectory.mockReset()
  mockListDirectory.mockResolvedValue([])
  mockStreamChat.mockReset()

  files.set(
    SOURCE_PATH,
    `[Document: ${SOURCE_NAME} — text extraction not supported for .doc format]`,
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
      enabled: false,
      useMainLlm: true,
      provider: "openai",
      apiKey: "",
      model: "",
      ollamaUrl: "",
      customEndpoint: "",
      apiMode: "chat_completions",
      concurrency: 1,
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

describe("autoIngest unsupported source extraction", () => {
  it("fails fast for legacy office files whose text extraction is unsupported", async () => {
    await expect(autoIngest(PROJECT, SOURCE_PATH, llmConfig)).rejects.toThrow(
      "Text extraction not supported for .doc format",
    )

    expect(mockStreamChat).not.toHaveBeenCalled()
    expect(files.has(`${PROJECT}/wiki/sources/legacy-source.md`)).toBe(false)
  })
})
