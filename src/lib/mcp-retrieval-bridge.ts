import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { getRelativePath, normalizePath } from "@/lib/path-utils"
import { searchWiki } from "@/lib/search"

export const MCP_RETRIEVAL_REQUEST_EVENT = "llm-wiki-mcp-retrieval-request"

interface McpRetrievalRequest {
  requestId: string
  projectId: string
  projectPath: string
  query: string
  limit?: number
}

interface McpRetrievalCompletion {
  requestId: string
  ok: boolean
  response?: {
    projectId: string
    query: string
    warning: string | null
    results: Array<{
      title: string
      relativePath: string
      score: number
      snippet: string
      titleMatch: boolean
    }>
  }
  error?: string
}

let unlisten: UnlistenFn | null = null
let starting: Promise<UnlistenFn> | null = null
let activeStarts = 0

export async function startMcpRetrievalBridge(): Promise<() => void> {
  activeStarts += 1
  let stopped = false

  try {
    await ensureMcpRetrievalBridgeListener()
  } catch (err) {
    activeStarts = Math.max(0, activeStarts - 1)
    throw err
  }

  return () => {
    if (stopped) return
    stopped = true
    activeStarts = Math.max(0, activeStarts - 1)
    if (activeStarts === 0) {
      stopMcpRetrievalBridge()
    }
  }
}

export function stopMcpRetrievalBridge(): void {
  unlisten?.()
  unlisten = null
  starting = null
  activeStarts = 0
}

async function ensureMcpRetrievalBridgeListener(): Promise<void> {
  if (unlisten) return
  if (!starting) {
    starting = listen<McpRetrievalRequest>(MCP_RETRIEVAL_REQUEST_EVENT, async (event) => {
      const request = event.payload
      if (!isRetrievalRequest(request)) return

      let completion: McpRetrievalCompletion
      try {
        const response = await buildRendererRetrievalResponse(request)
        completion = {
          requestId: request.requestId,
          ok: true,
          response,
        }
      } catch (err) {
        completion = {
          requestId: request.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }

      try {
        await completeRetrieval(completion)
      } catch (err) {
        console.error("Failed to complete MCP retrieval request:", err)
      }
    }).then((stop) => {
      unlisten = stop
      return stop
    }).finally(() => {
      starting = null
    })
  }
  await starting
}

async function buildRendererRetrievalResponse(request: McpRetrievalRequest): Promise<NonNullable<McpRetrievalCompletion["response"]>> {
  const projectPath = normalizePath(request.projectPath)
  const wikiRoot = `${projectPath}/wiki`
  const limit = request.limit ?? 10
  const results = await searchWiki(projectPath, request.query)

  return {
    projectId: request.projectId,
    query: request.query,
    warning: null,
    results: results
      .slice(0, limit)
      .map((result) => ({
        title: result.title,
        relativePath: getRelativePath(result.path, wikiRoot),
        score: result.score,
        snippet: result.snippet,
        titleMatch: result.titleMatch,
      })),
  }
}

async function completeRetrieval(completion: McpRetrievalCompletion): Promise<void> {
  await invoke("mcp_complete_retrieval", { completion })
}

function isRetrievalRequest(value: unknown): value is McpRetrievalRequest {
  if (!value || typeof value !== "object") return false
  const request = value as Partial<McpRetrievalRequest>
  return (
    typeof request.requestId === "string" &&
    request.requestId.length > 0 &&
    typeof request.projectId === "string" &&
    typeof request.projectPath === "string" &&
    typeof request.query === "string"
  )
}
