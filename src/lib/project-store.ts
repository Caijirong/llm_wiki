import { load } from "@tauri-apps/plugin-store"
import type { WikiProject } from "@/types/wiki"
import type {
  LlmConfig,
  SearchApiConfig,
  EmbeddingConfig,
  MultimodalConfig,
  McpConfig,
  FileReceiverConfig,
  OutputLanguage,
  ProviderConfigs,
} from "@/stores/wiki-store"

const STORE_NAME = "app-state.json"
const RECENT_PROJECTS_KEY = "recentProjects"
const LAST_PROJECT_KEY = "lastProject"

async function getStore() {
  return load(STORE_NAME, { autoSave: true, defaults: {} })
}

export async function getRecentProjects(): Promise<WikiProject[]> {
  const store = await getStore()
  const projects = await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)
  return projects ?? []
}

export async function getLastProject(): Promise<WikiProject | null> {
  const store = await getStore()
  const project = await store.get<WikiProject>(LAST_PROJECT_KEY)
  return project ?? null
}

export async function saveLastProject(project: WikiProject): Promise<void> {
  const store = await getStore()
  await store.set(LAST_PROJECT_KEY, project)
  await addToRecentProjects(project)
}

export async function addToRecentProjects(
  project: WikiProject
): Promise<void> {
  const store = await getStore()
  const existing = (await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)) ?? []
  const filtered = existing.filter((p) => p.path !== project.path)
  const updated = [project, ...filtered].slice(0, 10)
  await store.set(RECENT_PROJECTS_KEY, updated)
}

const LLM_CONFIG_KEY = "llmConfig"
const PROVIDER_CONFIGS_KEY = "providerConfigs"
const ACTIVE_PRESET_KEY = "activePresetId"

export async function saveLlmConfig(config: LlmConfig): Promise<void> {
  const store = await getStore()
  await store.set(LLM_CONFIG_KEY, config)
}

export async function loadLlmConfig(): Promise<LlmConfig | null> {
  const store = await getStore()
  return (await store.get<LlmConfig>(LLM_CONFIG_KEY)) ?? null
}

export async function saveProviderConfigs(configs: ProviderConfigs): Promise<void> {
  const store = await getStore()
  await store.set(PROVIDER_CONFIGS_KEY, configs)
}

export async function loadProviderConfigs(): Promise<ProviderConfigs | null> {
  const store = await getStore()
  return (await store.get<ProviderConfigs>(PROVIDER_CONFIGS_KEY)) ?? null
}

export async function saveActivePresetId(id: string | null): Promise<void> {
  const store = await getStore()
  await store.set(ACTIVE_PRESET_KEY, id)
}

export async function loadActivePresetId(): Promise<string | null> {
  const store = await getStore()
  return (await store.get<string | null>(ACTIVE_PRESET_KEY)) ?? null
}

const SEARCH_API_KEY = "searchApiConfig"

export async function saveSearchApiConfig(config: SearchApiConfig): Promise<void> {
  const store = await getStore()
  await store.set(SEARCH_API_KEY, config)
}

export async function loadSearchApiConfig(): Promise<SearchApiConfig | null> {
  const store = await getStore()
  return (await store.get<SearchApiConfig>(SEARCH_API_KEY)) ?? null
}

const EMBEDDING_KEY = "embeddingConfig"

export async function saveEmbeddingConfig(config: EmbeddingConfig): Promise<void> {
  const store = await getStore()
  await store.set(EMBEDDING_KEY, config)
}

export async function loadEmbeddingConfig(): Promise<EmbeddingConfig | null> {
  const store = await getStore()
  return (await store.get<EmbeddingConfig>(EMBEDDING_KEY)) ?? null
}

const MULTIMODAL_KEY = "multimodalConfig"

export async function saveMultimodalConfig(config: MultimodalConfig): Promise<void> {
  const store = await getStore()
  await store.set(MULTIMODAL_KEY, config)
}

export async function loadMultimodalConfig(): Promise<MultimodalConfig | null> {
  const store = await getStore()
  return (await store.get<MultimodalConfig>(MULTIMODAL_KEY)) ?? null
}

const MCP_CONFIG_KEY = "mcpConfig"
const FILE_RECEIVER_CONFIG_KEY = "fileReceiverConfig"
const DEFAULT_FILE_RECEIVER_CONFIG: FileReceiverConfig = {
  enabled: false,
  autoStart: false,
  staticToken: "",
  maxFileSizeBytes: 1024 * 1024 * 1024,
  uploadTtlHours: 24 * 7,
}

export async function saveMcpConfig(config: McpConfig): Promise<void> {
  const store = await getStore()
  await store.set(MCP_CONFIG_KEY, config)
}

export async function loadMcpConfig(): Promise<McpConfig | null> {
  const store = await getStore()
  return (await store.get<McpConfig>(MCP_CONFIG_KEY)) ?? null
}

export async function saveFileReceiverConfig(config: FileReceiverConfig): Promise<void> {
  const store = await getStore()
  await store.set(FILE_RECEIVER_CONFIG_KEY, {
    enabled: config.enabled,
    autoStart: config.autoStart,
    staticToken: config.staticToken,
    maxFileSizeBytes: config.maxFileSizeBytes,
    uploadTtlHours: config.uploadTtlHours,
  } satisfies FileReceiverConfig)
}

export async function loadFileReceiverConfig(): Promise<FileReceiverConfig | null> {
  const store = await getStore()
  const raw = await store.get<Record<string, unknown>>(FILE_RECEIVER_CONFIG_KEY)
  if (!raw || typeof raw !== "object") return null

  return {
    enabled:
      typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_FILE_RECEIVER_CONFIG.enabled,
    autoStart:
      typeof raw.autoStart === "boolean" ? raw.autoStart : DEFAULT_FILE_RECEIVER_CONFIG.autoStart,
    staticToken:
      typeof raw.staticToken === "string" ? raw.staticToken : DEFAULT_FILE_RECEIVER_CONFIG.staticToken,
    maxFileSizeBytes:
      typeof raw.maxFileSizeBytes === "number" ? raw.maxFileSizeBytes : DEFAULT_FILE_RECEIVER_CONFIG.maxFileSizeBytes,
    uploadTtlHours:
      typeof raw.uploadTtlHours === "number" ? raw.uploadTtlHours : DEFAULT_FILE_RECEIVER_CONFIG.uploadTtlHours,
  }
}

export async function removeFromRecentProjects(
  path: string
): Promise<void> {
  const store = await getStore()
  const existing = (await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)) ?? []
  const updated = existing.filter((p) => p.path !== path)
  await store.set(RECENT_PROJECTS_KEY, updated)
  // ALSO clear the last-project pointer if it points at the project
  // we just removed. Without this, App.tsx's startup auto-open
  // (`getLastProject()` → `openProject()` → `saveLastProject()`)
  // re-adds the removed entry back to recents on the next launch,
  // making the delete look like it didn't take. Reported by user
  // as "deleted project comes back after restart."
  const last = await store.get<WikiProject>(LAST_PROJECT_KEY)
  if (last && last.path === path) {
    await store.delete(LAST_PROJECT_KEY)
  }
}

const LANGUAGE_KEY = "language"

export async function saveLanguage(lang: string): Promise<void> {
  const store = await getStore()
  await store.set(LANGUAGE_KEY, lang)
}

export async function loadLanguage(): Promise<string | null> {
  const store = await getStore()
  return (await store.get<string>(LANGUAGE_KEY)) ?? null
}

const OUTPUT_LANGUAGE_KEY = "outputLanguage"

export async function saveOutputLanguage(lang: OutputLanguage): Promise<void> {
  const store = await getStore()
  await store.set(OUTPUT_LANGUAGE_KEY, lang)
}

export async function loadOutputLanguage(): Promise<OutputLanguage | null> {
  const store = await getStore()
  return (await store.get<OutputLanguage>(OUTPUT_LANGUAGE_KEY)) ?? null
}

// ── Update-check persistence ──────────────────────────────────────────────
// Small slice of state the UI-layer update store hydrates from on boot.
// Only fields that should persist across launches: the user's "enable
// auto-check" toggle, the timestamp we last checked (so the 6-hour cache
// survives restarts), and the version the user explicitly dismissed
// (so we don't re-nag on every restart until a newer version is out).

const UPDATE_CHECK_STATE_KEY = "updateCheckState"

export interface PersistedUpdateCheckState {
  enabled: boolean
  lastCheckedAt: number | null
  dismissedVersion: string | null
}

export async function saveUpdateCheckState(
  state: PersistedUpdateCheckState,
): Promise<void> {
  const store = await getStore()
  await store.set(UPDATE_CHECK_STATE_KEY, state)
}

export async function loadUpdateCheckState(): Promise<PersistedUpdateCheckState | null> {
  const store = await getStore()
  return (
    (await store.get<PersistedUpdateCheckState>(UPDATE_CHECK_STATE_KEY)) ?? null
  )
}
