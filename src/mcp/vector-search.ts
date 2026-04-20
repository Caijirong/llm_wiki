import path from "node:path"
import { stat } from "node:fs/promises"

import type { VectorSearchResult } from "../lib/wiki-query.js"

export interface EmbeddingRuntimeConfig {
  endpoint: string
  model: string
  apiKey: string
}

export interface VectorSearchAvailability {
  available: boolean
  reason?: string
}

const VECTOR_TABLE_NAME = "wiki_vectors"

export function getEmbeddingConfigFromEnv(): EmbeddingRuntimeConfig | null {
  const endpoint = process.env.LLM_WIKI_EMBEDDING_ENDPOINT?.trim() ?? ""
  const model = process.env.LLM_WIKI_EMBEDDING_MODEL?.trim() ?? ""
  const apiKey = process.env.LLM_WIKI_EMBEDDING_API_KEY?.trim() ?? ""

  if (!endpoint || !model) {
    return null
  }

  return { endpoint, model, apiKey }
}

export function getVectorSearchAvailability(): VectorSearchAvailability {
  const config = getEmbeddingConfigFromEnv()
  if (!config) {
    return {
      available: false,
      reason: "Missing embedding configuration. Set LLM_WIKI_EMBEDDING_ENDPOINT and LLM_WIKI_EMBEDDING_MODEL.",
    }
  }

  return { available: true }
}

export async function vectorSearchWiki(
  projectPath: string,
  query: string,
  limit: number,
): Promise<VectorSearchResult[]> {
  const config = getEmbeddingConfigFromEnv()
  if (!config) return []

  const dbPath = path.join(projectPath, ".llm-wiki", "lancedb")
  if (!(await pathExists(dbPath))) return []

  const queryEmbedding = await fetchEmbedding(query, config)
  if (!queryEmbedding) return []

  const lancedb = await import("@lancedb/lancedb")
  const db = await lancedb.connect(dbPath)

  try {
    const tableNames = await db.tableNames()
    if (!tableNames.includes(VECTOR_TABLE_NAME)) {
      return []
    }

    const table = await db.openTable(VECTOR_TABLE_NAME)
    const rows = await table
      .vectorSearch(queryEmbedding)
      .select(["page_id", "_distance"])
      .limit(limit)
      .toArray()

    return rows.flatMap((row: Record<string, unknown>) => {
      const id = typeof row.page_id === "string" ? row.page_id : ""
      const distance = typeof row._distance === "number" ? row._distance : Number.NaN

      if (!id || Number.isNaN(distance)) {
        return []
      }

      return [{
        id,
        score: 1 / (1 + distance),
      }]
    })
  } finally {
    db.close()
  }
}

async function fetchEmbedding(
  text: string,
  config: EmbeddingRuntimeConfig,
): Promise<number[] | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`
  }

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      input: text.slice(0, 2000),
    }),
  })

  if (!response.ok) {
    return null
  }

  const data = await response.json() as { data?: Array<{ embedding?: number[] }> }
  return data.data?.[0]?.embedding ?? null
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}
