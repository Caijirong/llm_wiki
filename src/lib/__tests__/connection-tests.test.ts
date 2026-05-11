import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EmbeddingConfig, LlmConfig, SearchApiConfig } from "@/stores/wiki-store"
import {
  testEmbeddingConnection,
  testLlmConnection,
  testSearchConnection,
} from "@/lib/connection-tests"

const httpFetchMock = vi.hoisted(() => vi.fn())
const getHttpFetchMock = vi.hoisted(() => vi.fn(async () => httpFetchMock))
const isFetchNetworkErrorMock = vi.hoisted(() => vi.fn((err: unknown) => {
  if (!(err instanceof Error)) return false
  return err.message === "Load failed" || err.message === "Failed to fetch"
}))

vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: getHttpFetchMock,
  isFetchNetworkError: isFetchNetworkErrorMock,
}))

const baseLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  maxContextSize: 204800,
}

const baseSearchConfig: SearchApiConfig = {
  provider: "tavily",
  apiKey: "tvly-test",
}

const baseEmbeddingConfig: EmbeddingConfig = {
  enabled: true,
  endpoint: "http://127.0.0.1:1234/v1/embeddings",
  apiKey: "embed-test",
  model: "text-embedding-test",
}

describe("connection tests", () => {
  beforeEach(() => {
    httpFetchMock.mockReset()
    getHttpFetchMock.mockClear()
    isFetchNetworkErrorMock.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("tests an LLM provider with a short non-streaming request", async () => {
    httpFetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }))

    await expect(testLlmConnection(baseLlmConfig)).resolves.toEqual({
      label: "OpenAI (gpt-4o-mini)",
    })

    expect(getHttpFetchMock).toHaveBeenCalledTimes(1)
    expect(httpFetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
        }),
      })
    )
    const [, init] = httpFetchMock.mock.calls[0]
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "gpt-4o-mini",
      stream: false,
      max_tokens: 1,
      messages: [{ role: "user", content: expect.any(String) }],
    })
  })

  it("requires an LLM model before testing", async () => {
    await expect(
      testLlmConnection({ ...baseLlmConfig, model: "" })
    ).rejects.toThrow("Model is required")
    expect(httpFetchMock).not.toHaveBeenCalled()
  })

  it("tests Tavily search with one lightweight query", async () => {
    httpFetchMock.mockResolvedValueOnce(
      Response.json({
        results: [
          {
            title: "LLM Wiki",
            url: "https://example.com/wiki",
            content: "A wiki result",
          },
        ],
      })
    )

    await expect(testSearchConnection(baseSearchConfig)).resolves.toEqual({
      label: "Tavily",
    })

    expect(getHttpFetchMock).toHaveBeenCalledTimes(1)
    expect(httpFetchMock).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    )
    const [, init] = httpFetchMock.mock.calls[0]
    expect(JSON.parse(String(init.body))).toMatchObject({
      api_key: "tvly-test",
      max_results: 1,
    })
  })

  it("tests an embedding endpoint and validates the returned vector", async () => {
    httpFetchMock.mockResolvedValueOnce(
      Response.json({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      })
    )

    await expect(testEmbeddingConnection(baseEmbeddingConfig)).resolves.toEqual({
      label: "text-embedding-test (3 dimensions)",
    })

    expect(getHttpFetchMock).toHaveBeenCalledTimes(1)
    expect(httpFetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer embed-test",
        },
      })
    )
    const [, init] = httpFetchMock.mock.calls[0]
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "text-embedding-test",
      input: expect.any(String),
    })
  })

  it("reports embedding responses without vectors as connection failures", async () => {
    httpFetchMock.mockResolvedValueOnce(Response.json({ data: [] }))

    await expect(testEmbeddingConnection(baseEmbeddingConfig)).rejects.toThrow(
      "Embedding endpoint responded without an embedding vector"
    )
  })

  it("surfaces actionable custom endpoint network errors instead of raw Load failed", async () => {
    httpFetchMock.mockRejectedValueOnce(new Error("Load failed"))

    await expect(
      testLlmConnection({
        ...baseLlmConfig,
        provider: "custom",
        customEndpoint: "https://aiproxy.funny-tech.site",
        model: "gpt-5.4",
      })
    ).rejects.toThrow(
      "Network error reaching https://aiproxy.funny-tech.site/chat/completions. Check endpoint URL, API key, and connectivity."
    )
  })
})
