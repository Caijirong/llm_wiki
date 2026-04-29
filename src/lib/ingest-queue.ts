import { readFile, writeFile } from "@/commands/fs"
import { autoIngest, type IngestQueueMetadataPatch } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"

// ── Types ─────────────────────────────────────────────────────────────────

export interface IngestTask {
  id: string
  sourcePath: string  // relative to project: "raw/sources/folder/file.pdf"
  folderContext: string  // e.g. "AI-Research > papers" or ""
  status: "pending" | "processing" | "done" | "failed"
  addedAt: number
  error: string | null
  retryCount: number
  origin?: "desktop" | "mcp"
  mimeType?: string
  startedAt?: number
  finishedAt?: number
  filesWritten?: string[]
  reviewItemCount?: number
  cacheHit?: boolean
}

// ── State ─────────────────────────────────────────────────────────────────

let queue: IngestTask[] = []
let processing = false
let currentProjectPath = ""
let currentAbortController: AbortController | null = null
let lastWrittenFiles: string[] = []  // track files written by current ingest for cleanup

// ── Persistence ───────────────────────────────────────────────────────────

function queueFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-queue.json`
}

async function saveQueue(projectPath: string): Promise<void> {
  try {
    await writeFile(queueFilePath(projectPath), JSON.stringify(queue, null, 2))
  } catch {
    // non-critical
  }
}

function normalizeTask(raw: unknown): IngestTask | null {
  if (!raw || typeof raw !== "object") return null
  const task = raw as Partial<IngestTask>

  if (typeof task.sourcePath !== "string" || task.sourcePath.length === 0) return null

  const status = task.status === "pending" || task.status === "processing" || task.status === "done" || task.status === "failed"
    ? task.status
    : "pending"

  return {
    id: typeof task.id === "string" && task.id.length > 0 ? task.id : generateId(),
    sourcePath: task.sourcePath,
    folderContext: typeof task.folderContext === "string" ? task.folderContext : "",
    status,
    addedAt: typeof task.addedAt === "number" ? task.addedAt : Date.now(),
    error: typeof task.error === "string" ? task.error : null,
    retryCount: typeof task.retryCount === "number" ? task.retryCount : 0,
    origin: task.origin === "desktop" || task.origin === "mcp" ? task.origin : undefined,
    mimeType: typeof task.mimeType === "string" ? task.mimeType : undefined,
    startedAt: typeof task.startedAt === "number" ? task.startedAt : undefined,
    finishedAt: typeof task.finishedAt === "number" ? task.finishedAt : undefined,
    filesWritten: Array.isArray(task.filesWritten) && task.filesWritten.every((item) => typeof item === "string")
      ? task.filesWritten
      : undefined,
    reviewItemCount: typeof task.reviewItemCount === "number" ? task.reviewItemCount : undefined,
    cacheHit: typeof task.cacheHit === "boolean" ? task.cacheHit : undefined,
  }
}

async function loadQueue(projectPath: string): Promise<IngestTask[]> {
  try {
    const raw = await readFile(queueFilePath(projectPath))
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((task) => normalizeTask(task))
      .filter((task): task is IngestTask => task !== null)
  } catch {
    return []
  }
}

// ── Queue Operations ──────────────────────────────────────────────────────

function generateId(): string {
  return `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Add a file to the ingest queue.
 */
export async function enqueueIngest(
  projectPath: string,
  sourcePath: string,
  folderContext: string = "",
): Promise<string> {
  const pp = normalizePath(projectPath)
  currentProjectPath = pp

  const task: IngestTask = {
    id: generateId(),
    sourcePath,
    folderContext,
    status: "pending",
    addedAt: Date.now(),
    error: null,
    retryCount: 0,
    origin: "desktop",
  }

  queue.push(task)
  await saveQueue(pp)

  // Start processing if not already running
  processNext(pp)

  return task.id
}

/**
 * Add multiple files to the queue at once.
 */
export async function enqueueBatch(
  projectPath: string,
  files: Array<{ sourcePath: string; folderContext: string }>,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  currentProjectPath = pp
  const ids: string[] = []

  for (const file of files) {
    const task: IngestTask = {
      id: generateId(),
      sourcePath: file.sourcePath,
      folderContext: file.folderContext,
      status: "pending",
      addedAt: Date.now(),
      error: null,
      retryCount: 0,
      origin: "desktop",
    }
    queue.push(task)
    ids.push(task.id)
  }

  await saveQueue(pp)
  console.log(`[Ingest Queue] Enqueued ${files.length} files`)
  processNext(pp)

  return ids
}

/**
 * Retry a failed task.
 */
export async function retryTask(projectPath: string, taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return

  task.status = "pending"
  task.error = null
  await saveQueue(projectPath)
  processNext(normalizePath(projectPath))
}

/**
 * Cancel a pending or processing task.
 * If processing, aborts the LLM call and cleans up generated files.
 */
export async function cancelTask(projectPath: string, taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return

  if (task.status === "processing") {
    // Abort the in-progress LLM call
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
    }

    // Clean up any files written by the interrupted ingest
    if (lastWrittenFiles.length > 0) {
      const { deleteFile } = await import("@/commands/fs")
      for (const filePath of lastWrittenFiles) {
        try {
          const fullPath = isAbsolutePath(filePath)
            ? normalizePath(filePath)
            : `${normalizePath(projectPath)}/${normalizePath(filePath)}`
          await deleteFile(fullPath)
        } catch {
          // file may not exist
        }
      }
      console.log(`[Ingest Queue] Cleaned up ${lastWrittenFiles.length} files from cancelled task`)
      lastWrittenFiles = []
    }

    processing = false
  }

  queue = queue.filter((t) => t.id !== taskId)
  await saveQueue(projectPath)
  console.log(`[Ingest Queue] Cancelled: ${task.sourcePath}`)

  // Continue with next task
  processNext(normalizePath(projectPath))
}

/**
 * Clear all done/failed tasks from the queue.
 */
export async function clearCompletedTasks(projectPath: string): Promise<void> {
  queue = queue.filter((t) => t.status === "pending" || t.status === "processing")
  await saveQueue(projectPath)
}

/**
 * Patch persisted metadata for a task without changing status transitions.
 */
export async function updateTaskMetadata(
  projectPath: string,
  taskId: string,
  patch: Partial<IngestQueueMetadataPatch>,
): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return

  if (typeof patch.cacheHit === "boolean") {
    task.cacheHit = patch.cacheHit
  }
  if (Array.isArray(patch.filesWritten)) {
    task.filesWritten = patch.filesWritten
  }
  if (typeof patch.reviewItemCount === "number") {
    task.reviewItemCount = patch.reviewItemCount
  }
  if (typeof patch.finishedAt === "number") {
    task.finishedAt = patch.finishedAt
  }

  await saveQueue(normalizePath(projectPath))
}

/**
 * Get current queue state.
 */
export function getQueue(): readonly IngestTask[] {
  return queue.filter((t) => t.status !== "done")
}

/**
 * Get queue summary.
 */
export function getQueueSummary(): {
  pending: number
  processing: number
  failed: number
  done: number
  active: number
  history: number
  recordsTotal: number
  total: number
} {
  const visibleQueue = queue.filter((t) => t.status !== "done")
  const pending = visibleQueue.filter((t) => t.status === "pending").length
  const processingCount = visibleQueue.filter((t) => t.status === "processing").length
  const failed = visibleQueue.filter((t) => t.status === "failed").length
  const done = queue.filter((t) => t.status === "done").length
  const active = pending + processingCount
  const recordsTotal = queue.length
  const total = visibleQueue.length

  return {
    pending,
    processing: processingCount,
    failed,
    done,
    active,
    history: done + failed,
    recordsTotal,
    total,
  }
}

// ── Restore on startup ───────────────────────────────────────────────────

/**
 * Load queue from disk and resume processing.
 * Called on app startup.
 */
export async function restoreQueue(projectPath: string): Promise<void> {
  const pp = normalizePath(projectPath)
  currentProjectPath = pp
  const saved = await loadQueue(pp)

  if (saved.length === 0) {
    queue = []
    return
  }

  // Reset any "processing" tasks back to "pending" (interrupted by app close)
  let restored = 0
  for (const task of saved) {
    if (task.status === "processing") {
      task.status = "pending"
      restored++
    }
  }

  queue = saved
  await saveQueue(pp)

  const pending = queue.filter((t) => t.status === "pending").length
  const failed = queue.filter((t) => t.status === "failed").length

  if (pending > 0 || restored > 0) {
    console.log(`[Ingest Queue] Restored: ${pending} pending, ${failed} failed, ${restored} resumed from interrupted`)
    processNext(pp)
  }
}

/**
 * Pull in tasks that were appended externally to the persisted queue file,
 * such as MCP uploads arriving while the desktop app is already running.
 */
export async function syncQueueFromDisk(projectPath: string): Promise<void> {
  const pp = normalizePath(projectPath)
  currentProjectPath = pp
  const saved = await loadQueue(pp)

  if (saved.length === 0) return

  const knownTaskIds = new Set(queue.map((task) => task.id))
  let added = 0

  for (const task of saved) {
    if (knownTaskIds.has(task.id)) continue
    queue.push(task)
    knownTaskIds.add(task.id)
    added++
  }

  if (added === 0) return

  await saveQueue(pp)
  console.log(`[Ingest Queue] Synced ${added} external task(s) from disk`)
  processNext(pp)
}

// ── Processing ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3

function isAbsolutePath(path: string): boolean {
  const normalized = normalizePath(path)
  return normalized.startsWith("/")
    || normalized.startsWith("//")
    || /^[A-Za-z]:\//.test(normalized)
}

function resolveSourcePath(projectPath: string, sourcePath: string): string {
  const normalizedSourcePath = normalizePath(sourcePath)
  return isAbsolutePath(normalizedSourcePath)
    ? normalizedSourcePath
    : `${normalizePath(projectPath)}/${normalizedSourcePath}`
}

async function processNext(projectPath: string): Promise<void> {
  if (processing) return

  const next = queue.find((t) => t.status === "pending")
  if (!next) return

  processing = true
  next.status = "processing"
  next.startedAt = Date.now()
  next.error = null
  await saveQueue(projectPath)

  const pp = normalizePath(projectPath)
  const llmConfig = useWikiStore.getState().llmConfig

  // Check if LLM is configured
  if (!llmConfig.apiKey && llmConfig.provider !== "ollama" && llmConfig.provider !== "custom") {
    next.status = "failed"
    next.error = "LLM not configured — set API key in Settings"
    processing = false
    await saveQueue(pp)
    processNext(pp)
    return
  }

  const fullSourcePath = resolveSourcePath(pp, next.sourcePath)

  console.log(`[Ingest Queue] Processing: ${next.sourcePath} (${queue.filter((t) => t.status === "pending").length} remaining)`)

  // Create abort controller for this task
  currentAbortController = new AbortController()
  lastWrittenFiles = []

  try {
    const writtenFiles = await autoIngest(
      pp,
      fullSourcePath,
      llmConfig,
      currentAbortController.signal,
      next.folderContext,
      {
        queueTaskId: next.id,
        onQueueMetadata: (taskId, patch) => updateTaskMetadata(pp, taskId, patch),
      },
    )
    lastWrittenFiles = writtenFiles

    // Success: keep as done for persisted history
    currentAbortController = null
    lastWrittenFiles = []
    next.status = "done"
    next.error = null
    next.finishedAt = Date.now()
    next.filesWritten = writtenFiles
    await saveQueue(pp)

    console.log(`[Ingest Queue] Done: ${next.sourcePath}`)
  } catch (err) {
    currentAbortController = null
    const message = err instanceof Error ? err.message : String(err)
    next.retryCount++
    next.error = message

    if (next.retryCount >= MAX_RETRIES) {
      next.status = "failed"
      console.log(`[Ingest Queue] Failed (${next.retryCount}x): ${next.sourcePath} — ${message}`)
    } else {
      next.status = "pending" // will retry
      console.log(`[Ingest Queue] Error (retry ${next.retryCount}/${MAX_RETRIES}): ${next.sourcePath} — ${message}`)
    }

    await saveQueue(pp)
  }

  processing = false
  processNext(pp)
}
