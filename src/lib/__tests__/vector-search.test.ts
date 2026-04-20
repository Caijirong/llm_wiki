import { afterEach, describe, expect, it } from "vitest"

import {
  getEmbeddingConfigFromEnv,
  getVectorSearchAvailability,
} from "../../mcp/vector-search"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("getEmbeddingConfigFromEnv", () => {
  it("reads endpoint, model, and api key from environment variables", () => {
    process.env.LLM_WIKI_EMBEDDING_ENDPOINT = "http://127.0.0.1:11434/v1/embeddings"
    process.env.LLM_WIKI_EMBEDDING_MODEL = "text-embedding-3-small"
    process.env.LLM_WIKI_EMBEDDING_API_KEY = "test-key"

    expect(getEmbeddingConfigFromEnv()).toEqual({
      endpoint: "http://127.0.0.1:11434/v1/embeddings",
      model: "text-embedding-3-small",
      apiKey: "test-key",
    })
  })

  it("returns null when endpoint or model is missing", () => {
    delete process.env.LLM_WIKI_EMBEDDING_ENDPOINT
    process.env.LLM_WIKI_EMBEDDING_MODEL = "text-embedding-3-small"

    expect(getEmbeddingConfigFromEnv()).toBeNull()
  })
})

describe("getVectorSearchAvailability", () => {
  it("reports missing configuration clearly", () => {
    delete process.env.LLM_WIKI_EMBEDDING_ENDPOINT
    delete process.env.LLM_WIKI_EMBEDDING_MODEL

    expect(getVectorSearchAvailability()).toEqual({
      available: false,
      reason: "Missing embedding configuration. Set LLM_WIKI_EMBEDDING_ENDPOINT and LLM_WIKI_EMBEDDING_MODEL.",
    })
  })
})
