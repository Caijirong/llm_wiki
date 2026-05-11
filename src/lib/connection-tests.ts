import type { EmbeddingConfig, LlmConfig, SearchApiConfig } from "@/stores/wiki-store"
import { getProviderTestRequest } from "@/lib/llm-providers"
import { getHttpFetch, isFetchNetworkError } from "@/lib/tauri-fetch"
import { webSearch } from "@/lib/web-search"

export interface ConnectionTestResult {
  label: string
}

const CONNECTION_TIMEOUT_MS = 20_000
const TEST_QUERY = "llm wiki connection test"
const ERROR_BODY_LIMIT = 500

const LLM_PROVIDER_LABELS: Record<LlmConfig["provider"], string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  ollama: "Ollama",
  custom: "Custom",
  minimax: "MiniMax",
  "claude-code": "Claude Code",
}

const SEARCH_PROVIDER_LABELS: Record<SearchApiConfig["provider"], string> = {
  tavily: "Tavily",
  none: "Disabled",
}

export async function testLlmConnection(config: LlmConfig): Promise<ConnectionTestResult> {
  const normalized = normalizeLlmConfig(config)
  validateLlmConfig(normalized)

  const request = getProviderTestRequest(normalized)
  const response = await fetchWithTimeout(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
  })
  await assertOk(response, "LLM provider")

  return {
    label: `${LLM_PROVIDER_LABELS[normalized.provider]} (${normalized.model})`,
  }
}

export async function testSearchConnection(config: SearchApiConfig): Promise<ConnectionTestResult> {
  if (config.provider === "none") {
    throw new Error("Search provider is disabled")
  }
  const normalized = {
    provider: config.provider,
    apiKey: config.apiKey.trim(),
  }
  if (!normalized.apiKey) {
    throw new Error("Search API key is required")
  }

  await webSearch(TEST_QUERY, normalized, 1)

  return { label: SEARCH_PROVIDER_LABELS[normalized.provider] }
}

export async function testEmbeddingConnection(config: EmbeddingConfig): Promise<ConnectionTestResult> {
  const endpoint = config.endpoint.trim()
  const model = config.model.trim()
  const apiKey = config.apiKey.trim()
  if (!endpoint) {
    throw new Error("Embedding endpoint is required")
  }
  if (!model) {
    throw new Error("Embedding model is required")
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      input: TEST_QUERY,
    }),
  })
  await assertOk(response, "Embedding endpoint")

  const body = await response.json().catch(() => {
    throw new Error("Embedding endpoint returned invalid JSON")
  })
  const embedding = extractEmbedding(body)
  if (!embedding) {
    throw new Error("Embedding endpoint responded without an embedding vector")
  }

  return {
    label: `${model} (${embedding.length} dimensions)`,
  }
}

function normalizeLlmConfig(config: LlmConfig): LlmConfig {
  return {
    ...config,
    apiKey: config.apiKey.trim(),
    model: config.model.trim(),
    ollamaUrl: trimTrailingSlashes(config.ollamaUrl.trim()),
    customEndpoint: trimTrailingSlashes(config.customEndpoint.trim()),
  }
}

function validateLlmConfig(config: LlmConfig) {
  if (!config.model) {
    throw new Error("Model is required")
  }

  if (config.provider === "ollama") {
    if (!config.ollamaUrl) {
      throw new Error("Ollama URL is required")
    }
    return
  }

  if (config.provider === "custom") {
    if (!config.customEndpoint) {
      throw new Error("Custom API endpoint is required")
    }
    return
  }

  if (config.provider === "claude-code") {
    throw new Error("Use the Claude Code CLI status check in the LLM settings row")
  }

  if (!config.apiKey) {
    throw new Error("API key is required")
  }
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "")
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS)

  try {
    const httpFetch = await getHttpFetch()
    return await httpFetch(url, {
      ...init,
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Connection test timed out after 20 seconds")
    }
    if (isFetchNetworkError(err)) {
      throw new Error(`Network error reaching ${url}. Check endpoint URL, API key, and connectivity.`)
    }
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    clearTimeout(timer)
  }
}

async function assertOk(response: Response, target: string): Promise<void> {
  if (response.ok) return

  const text = await response.text().catch(() => "")
  const detail = text.trim()
  const suffix = detail ? `: ${detail.slice(0, ERROR_BODY_LIMIT)}` : ""
  throw new Error(`${target} failed (${response.status} ${response.statusText})${suffix}`)
}

function extractEmbedding(body: unknown): number[] | null {
  if (!isRecord(body) || !Array.isArray(body.data) || body.data.length === 0) {
    return null
  }

  const first = body.data[0]
  if (!isRecord(first) || !Array.isArray(first.embedding)) {
    return null
  }

  if (!first.embedding.every((value) => typeof value === "number")) {
    return null
  }

  return first.embedding
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
