import { useRef, useEffect, useCallback, useState } from "react"
import { BookOpen, Plus, Trash2, MessageSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatMessage, StreamingMessage, useSourceFiles } from "./chat-message"
import { ChatInput } from "./chat-input"
import { useChatStore, chatMessagesToLLM } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { executeIngestWrites } from "@/lib/ingest"
import { listDirectory, readFile, writeFile, deleteFile } from "@/commands/fs"
import { searchWiki } from "@/lib/search"
import { buildRetrievalGraph, getRelatedNodes } from "@/lib/graph-relevance"
import { buildRetrievalContextBundle } from "@/lib/retrieval-core"
import { useReviewStore } from "@/stores/review-store"
import type { FileNode } from "@/types/wiki"
import { normalizePath, getFileName } from "@/lib/path-utils"
import { detectLanguage } from "@/lib/detect-language"

// Store the page mapping from the last query so SourceFilesBar can show which pages were cited
export let lastQueryPages: { title: string; path: string }[] = []

function formatDate(timestamp: number): string {
  const d = new Date(timestamp)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

function ConversationSidebar() {
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const messages = useChatStore((s) => s.messages)
  const createConversation = useChatStore((s) => s.createConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)

  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)

  function getMessageCount(convId: string): number {
    return messages.filter((m) => m.conversationId === convId).length
  }

  return (
    <div className="flex h-full w-[200px] flex-shrink-0 flex-col border-r bg-muted/30">
      <div className="border-b p-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={() => createConversation()}
        >
          <Plus className="h-3.5 w-3.5" />
          New Chat
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {sorted.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground text-center">
            No conversations yet
          </p>
        ) : (
          sorted.map((conv) => {
            const isActive = conv.id === activeConversationId
            const msgCount = getMessageCount(conv.id)
            return (
              <div
                key={conv.id}
                className={`group relative mx-1 my-0.5 flex cursor-pointer flex-col rounded-md px-2 py-1.5 text-sm transition-colors ${
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-accent text-foreground"
                }`}
                onClick={() => setActiveConversation(conv.id)}
                onMouseEnter={() => setHoveredId(conv.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div className="flex items-start justify-between gap-1">
                  <span className="line-clamp-2 flex-1 text-xs font-medium leading-snug">
                    {conv.title}
                  </span>
                  {hoveredId === conv.id && (
                    <button
                      className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteConversation(conv.id)
                        // Delete persisted chat file
                        const proj = useWikiStore.getState().project
                        if (proj) {
                          deleteFile(`${proj.path}/.llm-wiki/chats/${conv.id}.json`).catch(() => {})
                        }
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span>{formatDate(conv.updatedAt)}</span>
                  {msgCount > 0 && (
                    <>
                      <span>·</span>
                      <span>{msgCount} msgs</span>
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export function ChatPanel() {
  useSourceFiles() // Keep source file cache warm
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const streamingContent = useChatStore((s) => s.streamingContent)
  const mode = useChatStore((s) => s.mode)
  const addMessage = useChatStore((s) => s.addMessage)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const appendStreamToken = useChatStore((s) => s.appendStreamToken)
  const finalizeStream = useChatStore((s) => s.finalizeStream)
  const createConversation = useChatStore((s) => s.createConversation)
  const removeLastAssistantMessage = useChatStore((s) => s.removeLastAssistantMessage)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)

  // Derive active messages via selector to re-render on message changes
  const allMessages = useChatStore((s) => s.messages)
  const activeMessages = activeConversationId
    ? allMessages.filter((m) => m.conversationId === activeConversationId)
    : []

  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setFileTree = useWikiStore((s) => s.setFileTree)

  const abortRef = useRef<AbortController | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when messages change or streaming content updates
  useEffect(() => {
    const container = scrollContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [activeMessages, streamingContent])

  const handleSend = useCallback(
    async (text: string) => {
      // Auto-create a conversation if none is active
      let convId = useChatStore.getState().activeConversationId
      if (!convId) {
        convId = createConversation()
      }

      addMessage("user", text)
      setStreaming(true)

      // Build system prompt with wiki context using graph-enhanced retrieval
      const systemMessages: LLMMessage[] = []
      let queryRefs: { title: string; path: string }[] = []
      if (project) {
        const pp = normalizePath(project.path)
        const dataVersion = useWikiStore.getState().dataVersion
        const maxCtx = llmConfig.maxContextSize || 204800

        const [rawIndex, purpose] = await Promise.all([
          readFile(`${pp}/wiki/index.md`).catch(() => ""),
          readFile(`${pp}/purpose.md`).catch(() => ""),
        ])

        // ── Phase 1: Tokenized search → top 10 ────────────────
        const searchResults = await searchWiki(pp, text)
        const topSearchResults = searchResults.slice(0, 10)

        // ── Phase 2: Graph 1-level expansion ───────────────────
        // Note: Vector search (if enabled) is already merged into searchResults
        // by searchWiki() in search.ts — no duplicate code needed here.
        const graph = await buildRetrievalGraph(pp, dataVersion)
        const expandedIds = new Set<string>()
        const searchHitPaths = new Set(topSearchResults.map((r) => r.path))
        const graphExpansions: { title: string; path: string; relevance: number }[] = []

        for (const result of topSearchResults) {
          const fileName = getFileName(result.path)
          const nodeId = fileName.replace(/\.md$/, "")
          const related = getRelatedNodes(nodeId, graph, 3)
          for (const { node, relevance } of related) {
            if (relevance < 2.0) continue
            if (searchHitPaths.has(node.path)) continue
            if (expandedIds.has(node.id)) continue
            expandedIds.add(node.id)
            graphExpansions.push({ title: node.title, path: node.path, relevance })
          }
        }
        graphExpansions.sort((a, b) => b.relevance - a.relevance)

        const retrievalBundle = await buildRetrievalContextBundle({
          projectPath: pp,
          query: text,
          maxContextSize: maxCtx,
          index: rawIndex,
          purpose,
          searchResults: topSearchResults,
          graphExpansions,
          overviewPath: `${pp}/wiki/overview.md`,
          readText: async (filePath) => readFile(filePath),
        })

        const pagesContext = retrievalBundle.pages.length > 0
          ? retrievalBundle.pages.map((p, i) =>
              `### [${i + 1}] ${p.title}\nPath: ${p.path}\n\n${p.content}`
            ).join("\n\n---\n\n")
          : "(No wiki pages found)"

        systemMessages.push({
          role: "system",
          content: [
            "You are a knowledgeable wiki assistant. Answer questions based on the wiki content provided below.",
            "",
            `## CRITICAL: Response Language`,
            `The user is writing in **${detectLanguage(text)}**. You MUST respond in **${detectLanguage(text)}** regardless of what language the wiki content is written in. This is a mandatory requirement.`,
            "",
            "## Rules",
            "- Answer based ONLY on the numbered wiki pages provided below.",
            "- If the provided pages don't contain enough information, say so honestly.",
            "- Use [[wikilink]] syntax to reference wiki pages.",
            "- When citing information, use the page number in brackets, e.g. [1], [2].",
            "- At the VERY END of your response, add a hidden comment listing which page numbers you used:",
            "  <!-- cited: 1, 3, 5 -->",
            "",
            "Use markdown formatting for clarity.",
            "",
            retrievalBundle.purpose ? `## Wiki Purpose\n${retrievalBundle.purpose}` : "",
            retrievalBundle.index ? `## Wiki Index\n${retrievalBundle.index}` : "",
            retrievalBundle.pages.length > 0 ? `## Page List\n${retrievalBundle.pageList}` : "",
            `## Wiki Pages\n\n${pagesContext}`,
          ].filter(Boolean).join("\n"),
        })

        lastQueryPages = retrievalBundle.references
        queryRefs = [...lastQueryPages]
      }

      // ── Conversation history with count limit ────────────────
      // Only include messages from the active conversation, last N messages
      const activeConvMessages = useChatStore.getState().getActiveMessages()
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-maxHistoryMessages)

      const llmMessages = [...systemMessages, ...chatMessagesToLLM(activeConvMessages)]

      const controller = new AbortController()
      abortRef.current = controller

      let accumulated = ""

      await streamChat(
        llmConfig,
        llmMessages,
        {
          onToken: (token) => {
            accumulated += token
            appendStreamToken(token)
          },
          onDone: () => {
            finalizeStream(accumulated, queryRefs)
            abortRef.current = null
            // save-worthy detection removed — user has direct "Save to Wiki" button on each message
          },
          onError: (err) => {
            finalizeStream(`Error: ${err.message}`, undefined)
            abortRef.current = null
          },
        },
        controller.signal,
      )
    },
    [llmConfig, addMessage, setStreaming, appendStreamToken, finalizeStream, createConversation, maxHistoryMessages],
  )

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const handleRegenerate = useCallback(async () => {
    if (isStreaming) return
    // Find the last user message in active conversation
    const active = useChatStore.getState().getActiveMessages()
    const lastUserMsg = [...active].reverse().find((m) => m.role === "user")
    if (!lastUserMsg) return
    // Remove the last assistant reply, then re-send
    removeLastAssistantMessage()
    // Small delay to let state update
    await new Promise((r) => setTimeout(r, 50))
    // Trigger send with the same text (handleSend will add a new user message,
    // so also remove the original to avoid duplication)
    // Actually: just call handleSend — but it adds a user message. To avoid dupe,
    // we remove the last user message too and let handleSend re-add it.
    const store = useChatStore.getState()
    const updatedActive = store.getActiveMessages()
    const lastUser = [...updatedActive].reverse().find((m) => m.role === "user")
    if (lastUser) {
      useChatStore.setState((s) => ({
        messages: s.messages.filter((m) => m.id !== lastUser.id),
      }))
    }
    handleSend(lastUserMsg.content)
  }, [isStreaming, removeLastAssistantMessage, handleSend])

  const handleWriteToWiki = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      await executeIngestWrites(pp, llmConfig, undefined, undefined)
      try {
        const tree = await listDirectory(pp)
        setFileTree(tree)
      } catch {
        // ignore
      }
    } catch (err) {
      console.error("Failed to write to wiki:", err)
    }
  }, [project, llmConfig, setFileTree])

  const hasAssistantMessages = activeMessages.some((m) => m.role === "assistant")
  const showWriteButton = mode === "ingest" && !isStreaming && hasAssistantMessages

  return (
    <div className="flex h-full flex-row overflow-hidden">
      <ConversationSidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        {!activeConversationId ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <div className="text-center">
              <MessageSquare className="mx-auto mb-3 h-8 w-8 opacity-30" />
              <p className="text-sm">Start a new conversation</p>
              <p className="mt-1 text-xs opacity-60">Click "New Chat" to begin</p>
            </div>
          </div>
        ) : (
          <>
            <div
              ref={scrollContainerRef}
              className="flex-1 overflow-y-auto px-3 py-2"
            >
              <div className="flex flex-col gap-3">
                {activeMessages.map((msg, idx) => {
                  // Check if this is the last assistant message
                  const isLastAssistant = msg.role === "assistant" &&
                    !activeMessages.slice(idx + 1).some((m) => m.role === "assistant")
                  return (
                    <ChatMessage
                      key={msg.id}
                      message={msg}
                      isLastAssistant={isLastAssistant && !isStreaming}
                      onRegenerate={isLastAssistant ? handleRegenerate : undefined}
                    />
                  )
                })}
                {isStreaming && <StreamingMessage content={streamingContent} />}
                <div ref={bottomRef} />
              </div>
            </div>

            {showWriteButton && (
              <div className="border-t px-3 py-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleWriteToWiki}
                  className="w-full gap-2"
                >
                  <BookOpen className="h-4 w-4" />
                  Write to Wiki
                </Button>
              </div>
            )}
          </>
        )}

        <ChatInput
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={isStreaming}
          placeholder={
            mode === "ingest"
              ? "Discuss the source or ask follow-up questions..."
              : "Type a message..."
          }
        />
      </div>
    </div>
  )
}

/**
 * Check if the LLM marked its response as save-worthy.
 * If so, add a review item prompting the user to save it.
 */
function checkSaveWorthy(response: string, question: string) {
  const match = response.match(/<!--\s*save-worthy:\s*yes\s*\|\s*(.+?)\s*-->/)
  if (!match) return

  const reason = match[1]
  const firstLine = response.split("\n").find((l) => l.trim() && !l.startsWith("<!--"))?.replace(/^#+\s*/, "").trim() ?? "Chat answer"
  const title = firstLine.slice(0, 60)

  const contentToSave = response
  const questionText = question

  useReviewStore.getState().addItem({
    type: "suggestion",
    title: `Save to Wiki: ${title}`,
    description: `${reason}\n\nQuestion: "${questionText.slice(0, 100)}${questionText.length > 100 ? "..." : ""}"`,
    options: [
      { label: "Save to Wiki", action: `save:${encodeContent(contentToSave)}` },
      { label: "Skip", action: "Skip" },
    ],
  })
}

function encodeContent(text: string): string {
  return btoa(encodeURIComponent(text))
}

function flattenFileNames(nodes: FileNode[]): string[] {
  const names: string[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      names.push(...flattenFileNames(node.children))
    } else if (!node.is_dir) {
      names.push(node.name)
    }
  }
  return names
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function flattenAllFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenAllFiles(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}
