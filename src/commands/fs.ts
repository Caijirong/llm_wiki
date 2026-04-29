import { invoke } from "@tauri-apps/api/core"
import type { FileNode, WikiProject } from "@/types/wiki"
import { ensureProjectId, upsertProjectInfo } from "@/lib/project-identity"
import type { FileReceiverConfig, McpConfig } from "@/stores/wiki-store"

/** Raw shape returned by the Rust commands — id is attached client-side. */
interface RawProject {
  name: string
  path: string
}

export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path })
}

export async function writeFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_file", { path, contents })
}

export async function listDirectory(path: string): Promise<FileNode[]> {
  return invoke<FileNode[]>("list_directory", { path })
}

export async function copyFile(
  source: string,
  destination: string
): Promise<void> {
  return invoke("copy_file", { source, destination })
}

export async function preprocessFile(path: string): Promise<string> {
  return invoke<string>("preprocess_file", { path })
}

export async function deleteFile(path: string): Promise<void> {
  return invoke("delete_file", { path })
}

export async function findRelatedWikiPages(
  projectPath: string,
  sourceName: string
): Promise<string[]> {
  return invoke<string[]>("find_related_wiki_pages", { projectPath, sourceName })
}

export async function createDirectory(path: string): Promise<void> {
  return invoke<void>("create_directory", { path })
}

export async function fileExists(path: string): Promise<boolean> {
  return invoke<boolean>("file_exists", { path })
}

/** Mirror of `commands::fs::FileBase64` (Rust side). */
export interface FileBase64 {
  base64: string
  mimeType: string
}

/**
 * Read any file off disk as base64 + a guessed mime type. The
 * vision-caption pipeline uses this to pick up extracted images
 * without having to read them as UTF-8 strings (PNG bytes aren't
 * valid UTF-8 — `readFile` would corrupt them).
 */
export async function readFileAsBase64(path: string): Promise<FileBase64> {
  return invoke<FileBase64>("read_file_as_base64", { path })
}

export async function createProject(
  name: string,
  path: string,
): Promise<WikiProject> {
  const raw = await invoke<RawProject>("create_project", { name, path })
  const id = await ensureProjectId(raw.path)
  await upsertProjectInfo(id, raw.path, raw.name)
  return { id, name: raw.name, path: raw.path }
}

export async function openProject(path: string): Promise<WikiProject> {
  const raw = await invoke<RawProject>("open_project", { path })
  const id = await ensureProjectId(raw.path)
  await upsertProjectInfo(id, raw.path, raw.name)
  return { id, name: raw.name, path: raw.path }
}

export async function clipServerStatus(): Promise<string> {
  return invoke<string>("clip_server_status")
}

export type McpRuntimeStatus =
  | "stopped"
  | "starting"
  | "running"
  | "port_conflict"
  | "no_project"
  | "error"

export interface McpStatus {
  status: McpRuntimeStatus
  host?: string
  port?: number
  currentProject?: string | null
  knownProjects?: string[]
  lastError?: string | null
}

export type FileReceiverRuntimeStatus =
  | "stopped"
  | "starting"
  | "running"
  | "port_conflict"
  | "error"

export interface FileReceiverStatus {
  status: FileReceiverRuntimeStatus
  host: string
  port: number
  knownProjects: string[]
  lastError: string | null
  maxFileSizeBytes: number
  uploadTtlHours: number
}

export type UploadStatus = "uploading" | "completed" | "failed" | "expired"

export interface UploadRecord {
  uploadId: string
  projectPath: string
  fileName: string
  mimeType: string | null
  folderContext: string
  status: UploadStatus
  receivedBytes: number
  totalSize: number | null
  storedSourcePath: string | null
  taskId: string | null
  error: string | null
  startedAt: number
  updatedAt: number
}

export interface UploadListResponse {
  uploads: UploadRecord[]
  total: number
}

export async function mcpStatus(): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_status")
}

export async function mcpStart(): Promise<void> {
  return invoke("mcp_start")
}

export async function mcpStop(): Promise<void> {
  return invoke("mcp_stop")
}

export async function mcpUpdateProject(projectPath: string | null): Promise<void> {
  return invoke("mcp_update_project", { projectPath })
}

export async function mcpUpdateKnownProjects(projectPaths: string[]): Promise<void> {
  return invoke("mcp_update_known_projects", { projectPaths })
}

export async function mcpUpdateConfig(config: McpConfig): Promise<void> {
  return invoke("mcp_update_config", { config })
}

export async function fileReceiverStatus(): Promise<FileReceiverStatus> {
  return invoke<FileReceiverStatus>("file_receiver_status")
}

export async function fileReceiverUpdateConfig(config: FileReceiverConfig): Promise<void> {
  return invoke("file_receiver_update_config", { config })
}

export async function fileReceiverUpdateKnownProjects(projectPaths: string[]): Promise<void> {
  return invoke("file_receiver_update_known_projects", { projectPaths })
}

export async function listUploads(params?: {
  projectPath?: string
  status?: UploadStatus
  limit?: number
}): Promise<UploadListResponse> {
  return invoke<UploadListResponse>("list_uploads", {
    projectPath: params?.projectPath ?? null,
    status: params?.status ?? null,
    limit: params?.limit ?? null,
  })
}

export async function getUpload(uploadId: string, projectPath?: string): Promise<UploadRecord | null> {
  return invoke<UploadRecord | null>("get_upload", {
    uploadId,
    projectPath: projectPath ?? null,
  })
}
