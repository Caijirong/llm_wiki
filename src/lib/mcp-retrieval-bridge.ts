import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { buildChatRetrievalContext } from "@/lib/chat-retrieval"
import { useWikiStore } from "@/stores/wiki-store"

export const MCP_RETRIEVAL_REQUEST_EVENT = "llm-wiki-mcp-retrieval-request"

type McpRetrievalKind = "search" | "context"

interface McpRetrievalRequest {
  requestId: string
  kind: McpRetrievalKind
  projectId: string
  projectPath: string
  query: string
  limit?: number
  maxPages?: number
  pageCharLimit?: number
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
    purpose: string
    schema: string
    index: string
    imageUsageInstructions: string
    knowledgeImages: Array<{
      id: number
      title: string
      alt: string
      sourcePath: string
      url: string
    }>
    pages: Array<{
      exists: boolean
      title: string
      relativePath: string
      content: string
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
  const maxContextSize = useWikiStore.getState().llmConfig.maxContextSize
  const context = await buildChatRetrievalContext({
    projectPath: request.projectPath,
    query: request.query,
    maxContextSize,
    maxPages: request.kind === "context" ? request.maxPages : undefined,
    pageCharLimit: request.pageCharLimit,
    searchLimit: request.limit,
  })

  return {
    projectId: request.projectId,
    query: request.query,
    warning: null,
    results: context.searchResults
      .slice(0, request.limit)
      .map((result) => ({
        title: result.title,
        relativePath: result.relativePath,
        score: result.score,
        snippet: result.snippet,
        titleMatch: result.titleMatch,
      })),
    purpose: context.purpose,
    schema: context.schema,
    index: context.index,
    imageUsageInstructions: buildMcpImageUsageInstructions(),
    knowledgeImages: context.knowledgeImages.map((image, index) => ({
      id: index + 1,
      title: extractKnowledgeImageTitle(image, index),
      alt: image.alt,
      sourcePath: image.sourcePath,
      url: buildMcpKnowledgeImageUrl(request.projectId, image.url),
    })),
    pages: context.pages.map((page) => ({
      exists: true,
      title: page.title,
      relativePath: page.path.replace(/^wiki\//, ""),
      content: page.content,
    })),
  }
}

async function completeRetrieval(completion: McpRetrievalCompletion): Promise<void> {
  await invoke("mcp_complete_retrieval", { completion })
}

function buildMcpImageUsageInstructions(): string {
  return [
    "Related images are available in knowledgeImages.",
    "Use an image only when it materially helps answer the question.",
    "If your client supports Markdown image rendering, you may inline it with ![title](url).",
    "Do not invent image URLs.",
    "Use each image at most once, in the single most relevant place.",
    "If image rendering is not supported, cite the image title and URL in text instead.",
  ].join(" ")
}

function buildMcpKnowledgeImageUrl(projectId: string, rawUrl: string): string {
  const normalizedPath = rawUrl.replace(/^\.?\//, "")
  const encodedSegments = normalizedPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  return `http://127.0.0.1:19827/wiki-media/${encodeURIComponent(projectId)}/${encodedSegments}`
}

function extractKnowledgeImageTitle(
  image: { alt: string; sourceTitle: string },
  index: number,
): string {
  const normalized = image.alt.replace(/[\r\n]+/g, " ").trim()
  if (!normalized) return `Image ${index + 1} from ${image.sourceTitle}`
  const sentenceEnd = normalized.search(/[。！？]|(?<!\d)[.!?](?!\d)/)
  const title = sentenceEnd > 0
    ? normalized.slice(0, sentenceEnd)
    : normalized
  return title.slice(0, 80).trim()
}

function isRetrievalRequest(value: unknown): value is McpRetrievalRequest {
  if (!value || typeof value !== "object") return false
  const request = value as Partial<McpRetrievalRequest>
  return (
    typeof request.requestId === "string" &&
    request.requestId.length > 0 &&
    (request.kind === "search" || request.kind === "context") &&
    typeof request.projectId === "string" &&
    typeof request.projectPath === "string" &&
    typeof request.query === "string"
  )
}
