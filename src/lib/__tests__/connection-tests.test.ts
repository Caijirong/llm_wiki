import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EmbeddingConfig, LlmConfig, SearchApiConfig } from "@/stores/wiki-store"
import {
  testEmbeddingConnection,
  testLlmConnection,
  testSearchConnection,
} from "@/lib/connection-tests"

const fetchMock = vi.fn()

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
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("tests an LLM provider with a short non-streaming request", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }))

    await expect(testLlmConnection(baseLlmConfig)).resolves.toEqual({
      label: "OpenAI (gpt-4o-mini)",
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
        }),
      })
    )
    const [, init] = fetchMock.mock.calls[0]
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
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("tests Tavily search with one lightweight query", async () => {
    fetchMock.mockResolvedValueOnce(
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

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    )
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(init.body))).toMatchObject({
      api_key: "tvly-test",
      max_results: 1,
    })
  })

  it("tests an embedding endpoint and validates the returned vector", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      })
    )

    await expect(testEmbeddingConnection(baseEmbeddingConfig)).resolves.toEqual({
      label: "text-embedding-test (3 dimensions)",
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer embed-test",
        },
      })
    )
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "text-embedding-test",
      input: expect.any(String),
    })
  })

  it("reports embedding responses without vectors as connection failures", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: [] }))

    await expect(testEmbeddingConnection(baseEmbeddingConfig)).rejects.toThrow(
      "Embedding endpoint responded without an embedding vector"
    )
  })
})
