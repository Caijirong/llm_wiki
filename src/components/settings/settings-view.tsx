import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Bot,
  Binary,
  Globe,
  Languages,
  Palette,
  Info,
  Image as ImageIcon,
  Server,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import i18n from "@/i18n"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useUpdateStore, hasAvailableUpdate } from "@/stores/update-store"
import { saveLanguage } from "@/lib/project-store"
import { normalizeFileReceiverConfigForMcp } from "@/lib/runtime-service-config"
import {
  fileReceiverStatus as fetchFileReceiverStatus,
  fileReceiverUpdateConfig,
  mcpStatus as fetchMcpStatus,
  mcpUpdateConfig,
  type FileReceiverStatus as FileReceiverRuntimeState,
  type McpStatus as McpRuntimeStatus,
} from "@/commands/fs"
import type { SettingsDraft, DraftSetter } from "./settings-types"
import { LlmProviderSection } from "./sections/llm-provider-section"
import { EmbeddingSection } from "./sections/embedding-section"
import { MultimodalSection } from "./sections/multimodal-section"
import { WebSearchSection } from "./sections/web-search-section"
import { OutputSection } from "./sections/output-section"
import { InterfaceSection } from "./sections/interface-section"
import { AboutSection } from "./sections/about-section"

type CategoryId =
  | "llm"
  | "embedding"
  | "multimodal"
  | "web-search"
  | "output"
  | "interface"
  | "services"
  | "about"

interface Category {
  id: CategoryId
  /** i18n key under settings.categories — resolved at render time so
   *  switching language in Settings → Interface takes effect without
   *  remounting this component (Bug #53). */
  labelKey: string
  icon: typeof Bot
}

const CATEGORIES: Category[] = [
  { id: "llm", labelKey: "settings.categories.llm", icon: Bot },
  { id: "embedding", labelKey: "settings.categories.embedding", icon: Binary },
  { id: "multimodal", labelKey: "settings.categories.multimodal", icon: ImageIcon },
  { id: "web-search", labelKey: "settings.categories.webSearch", icon: Globe },
  { id: "output", labelKey: "settings.categories.output", icon: Languages },
  { id: "interface", labelKey: "settings.categories.interface", icon: Palette },
  { id: "services", labelKey: "settings.categories.services", icon: Server },
  { id: "about", labelKey: "settings.categories.about", icon: Info },
]

function initialDraft(
  llm: ReturnType<typeof useWikiStore.getState>["llmConfig"],
  search: ReturnType<typeof useWikiStore.getState>["searchApiConfig"],
  embed: ReturnType<typeof useWikiStore.getState>["embeddingConfig"],
  multimodal: ReturnType<typeof useWikiStore.getState>["multimodalConfig"],
  outputLanguage: ReturnType<typeof useWikiStore.getState>["outputLanguage"],
  maxHistoryMessages: number,
  uiLanguage: string,
): SettingsDraft {
  return {
    provider: llm.provider,
    apiKey: llm.apiKey,
    model: llm.model,
    ollamaUrl: llm.ollamaUrl,
    customEndpoint: llm.customEndpoint,
    maxContextSize: llm.maxContextSize ?? 204800,
    apiMode: llm.apiMode,
    embeddingEnabled: embed.enabled,
    embeddingEndpoint: embed.endpoint,
    embeddingApiKey: embed.apiKey,
    embeddingModel: embed.model,
    embeddingMaxChunkChars: embed.maxChunkChars,
    embeddingOverlapChunkChars: embed.overlapChunkChars,
    multimodalEnabled: multimodal.enabled,
    multimodalUseMainLlm: multimodal.useMainLlm,
    multimodalProvider: multimodal.provider,
    multimodalApiKey: multimodal.apiKey,
    multimodalModel: multimodal.model,
    multimodalOllamaUrl: multimodal.ollamaUrl,
    multimodalCustomEndpoint: multimodal.customEndpoint,
    multimodalApiMode: multimodal.apiMode,
    multimodalConcurrency: multimodal.concurrency,
    searchProvider: search.provider,
    searchApiKey: search.apiKey,
    outputLanguage,
    maxHistoryMessages,
    uiLanguage,
  }
}

export function SettingsView() {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setLlmConfig = useWikiStore((s) => s.setLlmConfig)
  const searchApiConfig = useWikiStore((s) => s.searchApiConfig)
  const setSearchApiConfig = useWikiStore((s) => s.setSearchApiConfig)
  const embeddingConfig = useWikiStore((s) => s.embeddingConfig)
  const setEmbeddingConfig = useWikiStore((s) => s.setEmbeddingConfig)
  const multimodalConfig = useWikiStore((s) => s.multimodalConfig)
  const setMultimodalConfig = useWikiStore((s) => s.setMultimodalConfig)
  const outputLanguage = useWikiStore((s) => s.outputLanguage)
  const setOutputLanguage = useWikiStore((s) => s.setOutputLanguage)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)
  const setMaxHistoryMessages = useChatStore((s) => s.setMaxHistoryMessages)
  // Drives the red dot next to the "About" row in the settings
  // sidebar. Uses `hasAvailableUpdate` (NOT `shouldShowUpdateBanner`)
  // so the indicator remains even after the user dismisses the
  // top banner — the user explicitly asked for the gear/About dots
  // to keep showing as a signpost so they can find the update
  // again later. The top banner stays gated by the dismiss
  // preference so the more aggressive interruption only fires once
  // per version.
  const updateAvailable = useUpdateStore((s) => hasAvailableUpdate(s))

  const [active, setActive] = useState<CategoryId>("llm")
  const [saved, setSaved] = useState(false)
  const [draft, setDraftState] = useState<SettingsDraft>(() =>
    initialDraft(
      llmConfig,
      searchApiConfig,
      embeddingConfig,
      multimodalConfig,
      outputLanguage,
      maxHistoryMessages,
      i18n.language,
    ),
  )

  // Resync draft from store if it changes out-of-band (e.g. project switch).
  useEffect(() => {
    setDraftState(
      initialDraft(
        llmConfig,
        searchApiConfig,
        embeddingConfig,
        multimodalConfig,
        outputLanguage,
        maxHistoryMessages,
        i18n.language,
      ),
    )
  }, [
    llmConfig,
    searchApiConfig,
    embeddingConfig,
    multimodalConfig,
    outputLanguage,
    maxHistoryMessages,
  ])

  const setDraft: DraftSetter = useCallback((key, value) => {
    setDraftState((prev) => ({ ...prev, [key]: value }))
  }, [])

  const handleSave = useCallback(async () => {
    const {
      saveLlmConfig,
      saveSearchApiConfig,
      saveEmbeddingConfig,
      saveMultimodalConfig,
      saveOutputLanguage,
    } = await import("@/lib/project-store")

    const newLlm = {
      provider: draft.provider,
      apiKey: draft.apiKey,
      model: draft.model,
      ollamaUrl: draft.ollamaUrl,
      customEndpoint: draft.customEndpoint,
      maxContextSize: draft.maxContextSize,
      apiMode: draft.provider === "custom" ? draft.apiMode : undefined,
    }
    const newSearch = { provider: draft.searchProvider, apiKey: draft.searchApiKey }
    const newEmbed = {
      enabled: draft.embeddingEnabled,
      endpoint: draft.embeddingEndpoint,
      apiKey: draft.embeddingApiKey,
      model: draft.embeddingModel,
      maxChunkChars: draft.embeddingMaxChunkChars,
      overlapChunkChars: draft.embeddingOverlapChunkChars,
    }
    const newMultimodal = {
      enabled: draft.multimodalEnabled,
      useMainLlm: draft.multimodalUseMainLlm,
      provider: draft.multimodalProvider,
      apiKey: draft.multimodalApiKey,
      model: draft.multimodalModel,
      ollamaUrl: draft.multimodalOllamaUrl,
      customEndpoint: draft.multimodalCustomEndpoint,
      apiMode: draft.multimodalProvider === "custom" ? draft.multimodalApiMode : undefined,
      // Clamp at save time so a hand-edited persisted store with a
      // ridiculous concurrency value (e.g. someone setting 1000 in
      // the JSON) doesn't blow up the captioning pipeline. Caption
      // calls already share the LLM endpoint with everything else;
      // going wider than ~16 just queues behind the server's batch
      // slot.
      concurrency: Math.max(1, Math.min(16, draft.multimodalConcurrency || 4)),
    }

    setLlmConfig(newLlm)
    await saveLlmConfig(newLlm)
    setSearchApiConfig(newSearch)
    await saveSearchApiConfig(newSearch)
    setEmbeddingConfig(newEmbed)
    await saveEmbeddingConfig(newEmbed)
    setMultimodalConfig(newMultimodal)
    await saveMultimodalConfig(newMultimodal)
    setOutputLanguage(draft.outputLanguage as typeof outputLanguage)
    await saveOutputLanguage(draft.outputLanguage as typeof outputLanguage)
    setMaxHistoryMessages(draft.maxHistoryMessages)

    if (draft.uiLanguage !== i18n.language) {
      await i18n.changeLanguage(draft.uiLanguage)
      await saveLanguage(draft.uiLanguage)
    }

    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [
    draft,
    setLlmConfig,
    setSearchApiConfig,
    setEmbeddingConfig,
    setOutputLanguage,
    setMaxHistoryMessages,
    outputLanguage,
  ])

  const body = useMemo(() => {
    switch (active) {
      case "llm":
        // The LLM section manages its own store state (per-provider
        // configs + active preset) and persists directly — it bypasses
        // the shared draft / global Save button.
        return <LlmProviderSection />
      case "embedding":
        return <EmbeddingSection draft={draft} setDraft={setDraft} />
      case "multimodal":
        return <MultimodalSection draft={draft} setDraft={setDraft} />
      case "web-search":
        return <WebSearchSection draft={draft} setDraft={setDraft} />
      case "output":
        return <OutputSection draft={draft} setDraft={setDraft} />
      case "interface":
        return <InterfaceSection draft={draft} setDraft={setDraft} />
      case "services":
        return <ServicesSection />
      case "about":
        return <AboutSection />
    }
  }, [active, draft, setDraft])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar — category nav. Matches the IconSidebar's pill-on-accent
          pattern so the two navigational surfaces feel like one app. */}
      <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/30">
        <div className="px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("settings.title")}
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          {CATEGORIES.map((c) => {
            const Icon = c.icon
            const isActive = c.id === active
            // Mirror the gear-icon dot inside the settings sidebar
            // so the user can find which sub-section the update
            // notification is pointing at. Update info lives in
            // the About panel, so the dot follows the About row.
            // Same store, same gating — once dismissed, both
            // disappear together.
            const showUpdateDot =
              c.id === "about" && updateAvailable
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setActive(c.id)}
                aria-current={isActive ? "page" : undefined}
                className={`group mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  isActive
                    ? "bg-foreground/[0.08] font-medium text-foreground ring-1 ring-border/70"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 transition-colors ${
                    isActive ? "text-primary" : "text-muted-foreground/80 group-hover:text-accent-foreground"
                  }`}
                />
                <span className="truncate">{t(c.labelKey)}</span>
                {showUpdateDot && (
                  <span
                    className="ml-auto h-2 w-2 shrink-0 rounded-full bg-red-500"
                    aria-label={t("nav.updateAvailable")}
                    title={t("nav.updateAvailable")}
                  />
                )}
              </button>
            )
          })}
        </nav>
      </aside>

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="mx-auto max-w-2xl">{body}</div>
        </div>

        {/* Global Save bar hidden for sections that persist inline:
            - "llm" saves per-row on every edit (independent per-preset state)
            - "about" has no editable fields */}
        {active !== "about" && active !== "llm" && active !== "services" && (
          <div className="shrink-0 border-t bg-background/80 backdrop-blur px-8 py-3">
            <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
              <p className="text-xs text-muted-foreground">
                {saved ? t("settings.savedTick") : t("settings.changeHint")}
              </p>
              <Button onClick={handleSave}>
                {saved ? t("settings.saved") : t("settings.save")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ServicesSection() {
  const { t } = useTranslation()
  const mcpConfig = useWikiStore((s) => s.mcpConfig)
  const setMcpConfig = useWikiStore((s) => s.setMcpConfig)
  const fileReceiverConfig = useWikiStore((s) => s.fileReceiverConfig)
  const setFileReceiverConfig = useWikiStore((s) => s.setFileReceiverConfig)
  const [mcpEnabled, setMcpEnabled] = useState(mcpConfig.enabled)
  const [mcpAutoStart, setMcpAutoStart] = useState(mcpConfig.autoStart)
  const [mcpHost, setMcpHost] = useState(mcpConfig.host)
  const [mcpPort, setMcpPort] = useState(String(mcpConfig.port))
  const [mcpRuntime, setMcpRuntime] = useState<McpRuntimeStatus | null>(null)
  const [fileReceiverToken, setFileReceiverToken] = useState(fileReceiverConfig.staticToken)
  const [fileReceiverMaxFileSizeMb, setFileReceiverMaxFileSizeMb] = useState(
    String(Math.max(1, Math.round(fileReceiverConfig.maxFileSizeBytes / (1024 * 1024)))),
  )
  const [fileReceiverUploadTtlHours, setFileReceiverUploadTtlHours] = useState(
    String(fileReceiverConfig.uploadTtlHours),
  )
  const [fileReceiverRuntime, setFileReceiverRuntime] = useState<FileReceiverRuntimeState | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setMcpEnabled(mcpConfig.enabled)
    setMcpAutoStart(mcpConfig.autoStart)
    setMcpHost(mcpConfig.host)
    setMcpPort(String(mcpConfig.port))
  }, [mcpConfig])

  useEffect(() => {
    setFileReceiverToken(fileReceiverConfig.staticToken)
    setFileReceiverMaxFileSizeMb(
      String(Math.max(1, Math.round(fileReceiverConfig.maxFileSizeBytes / (1024 * 1024)))),
    )
    setFileReceiverUploadTtlHours(String(fileReceiverConfig.uploadTtlHours))
  }, [fileReceiverConfig])

  async function refreshRuntime() {
    try {
      const [mcpRuntimeState, fileReceiverRuntimeState] = await Promise.all([
        fetchMcpStatus(),
        fetchFileReceiverStatus(),
      ])
      setMcpRuntime(mcpRuntimeState)
      setFileReceiverRuntime(fileReceiverRuntimeState)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setMcpRuntime({
        status: "error",
        lastError: message,
      })
      setFileReceiverRuntime({
        status: "error",
        host: mcpHost.trim() || "127.0.0.1",
        port: parseMcpPort(mcpPort),
        knownProjects: [],
        lastError: message,
        maxFileSizeBytes: parseFileReceiverMaxFileSizeBytes(fileReceiverMaxFileSizeMb),
        uploadTtlHours: parseFileReceiverUploadTtlHours(fileReceiverUploadTtlHours),
      })
    }
  }

  useEffect(() => {
    let active = true
    const refresh = async () => {
      if (!active) return
      await refreshRuntime()
    }
    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  async function handleSave() {
    const { saveFileReceiverConfig, saveMcpConfig } = await import("@/lib/project-store")
    const normalizedMcpHost = mcpHost.trim() || "127.0.0.1"
    const normalizedMcpPort = parseMcpPort(mcpPort)
    const nextMcpConfig = {
      enabled: mcpEnabled,
      autoStart: mcpAutoStart,
      host: normalizedMcpHost,
      port: normalizedMcpPort,
    }
    const nextFileReceiverConfig = normalizeFileReceiverConfigForMcp(nextMcpConfig, {
      enabled: mcpEnabled,
      autoStart: mcpAutoStart,
      staticToken: fileReceiverToken.trim(),
      maxFileSizeBytes: parseFileReceiverMaxFileSizeBytes(fileReceiverMaxFileSizeMb),
      uploadTtlHours: parseFileReceiverUploadTtlHours(fileReceiverUploadTtlHours),
    })

    setMcpConfig(nextMcpConfig)
    await saveMcpConfig(nextMcpConfig)
    await mcpUpdateConfig(nextMcpConfig)
    setFileReceiverConfig(nextFileReceiverConfig)
    setFileReceiverToken(nextFileReceiverConfig.staticToken)
    await saveFileReceiverConfig(nextFileReceiverConfig)
    await fileReceiverUpdateConfig(nextFileReceiverConfig)
    await refreshRuntime()
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const sharedListenerSettingsVisible = mcpEnabled
  const sharedExternalHost = mcpHost.trim() || "127.0.0.1"
  const sharedExternalPort = parseMcpPort(mcpPort)
  const mcpEndpointPreview = `http://${sharedExternalHost}:${sharedExternalPort}/mcp`
  const fileReceiverEndpointPreview = `http://${sharedExternalHost}:${sharedExternalPort}/uploads`
  const mcpRuntimeLabel = mcpRuntime
    ? formatRuntimeStatus(mcpRuntime.status)
    : t("settings.mcpStatusPlaceholder")
  const fileReceiverRuntimeLabel = fileReceiverRuntime
    ? formatRuntimeStatus(fileReceiverRuntime.status)
    : t("settings.fileReceiverStatusPlaceholder")

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.services.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.services.description")}
        </p>
      </div>

      <div className="space-y-4 rounded-md border p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">{t("settings.mcpServer")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t("settings.mcpDescription")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={mcpEnabled}
            aria-label={t("settings.enableMcp")}
            onClick={() => setMcpEnabled(!mcpEnabled)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              mcpEnabled ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                mcpEnabled ? "translate-x-4.5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>

        {mcpEnabled && (
          <div className="flex items-center gap-2">
            <input
              id="mcpAutoStart"
              type="checkbox"
              checked={mcpAutoStart}
              onChange={(e) => setMcpAutoStart(e.target.checked)}
            />
            <Label htmlFor="mcpAutoStart">{t("settings.autoStartMcp")}</Label>
          </div>
        )}

        {sharedListenerSettingsVisible && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="mcpHost">{t("settings.host")}</Label>
                <Input
                  id="mcpHost"
                  value={mcpHost}
                  onChange={(e) => setMcpHost(e.target.value)}
                  placeholder="127.0.0.1"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcpPort">{t("settings.port")}</Label>
                <Input
                  id="mcpPort"
                  type="number"
                  min={1}
                  value={mcpPort}
                  onChange={(e) => setMcpPort(e.target.value)}
                  placeholder="18765"
                />
              </div>
            </div>

            {mcpHost.trim() === "0.0.0.0" && (
              <p className="text-xs text-amber-600">{t("settings.mcpHostWarning")}</p>
            )}

            <div className="space-y-1 rounded-md bg-muted/40 p-3 text-xs">
              <p>{t("settings.mcpRuntimeStatus")}: {mcpRuntimeLabel}</p>
              <p>{t("settings.mcpEndpointPreview")}: {mcpEndpointPreview}</p>
              {mcpRuntime?.currentProject && <p>Project: {mcpRuntime.currentProject}</p>}
              {mcpRuntime?.lastError && <p className="text-red-600">{mcpRuntime.lastError}</p>}
            </div>

            <div className="space-y-4 border-t pt-4">
              <div className="space-y-1">
                <h4 className="text-sm font-semibold">{t("settings.uploadImport")}</h4>
                <p className="text-xs text-muted-foreground">{t("settings.fileReceiverSharedEndpointHint")}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="fileReceiverToken">{t("settings.fileReceiverToken")}</Label>
                <Input
                  id="fileReceiverToken"
                  type="password"
                  value={fileReceiverToken}
                  onChange={(e) => setFileReceiverToken(e.target.value)}
                  placeholder={t("settings.fileReceiverTokenPlaceholder")}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="fileReceiverMaxFileSizeMb">{t("settings.fileReceiverMaxSizeMb")}</Label>
                  <Input
                    id="fileReceiverMaxFileSizeMb"
                    type="number"
                    min={1}
                    value={fileReceiverMaxFileSizeMb}
                    onChange={(e) => setFileReceiverMaxFileSizeMb(e.target.value)}
                    placeholder="1024"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="fileReceiverUploadTtlHours">{t("settings.fileReceiverUploadTtlHours")}</Label>
                  <Input
                    id="fileReceiverUploadTtlHours"
                    type="number"
                    min={1}
                    value={fileReceiverUploadTtlHours}
                    onChange={(e) => setFileReceiverUploadTtlHours(e.target.value)}
                    placeholder="168"
                  />
                </div>
              </div>

              <div className="space-y-1 rounded-md bg-muted/40 p-3 text-xs">
                <p>{t("settings.fileReceiverRuntimeStatus")}: {fileReceiverRuntimeLabel}</p>
                <p>{t("settings.fileReceiverEndpointPreview")}: {fileReceiverEndpointPreview}</p>
                <p>{t("settings.fileReceiverKnownProjects")}: {fileReceiverRuntime?.knownProjects.length ?? 0}</p>
                <p>
                  {t("settings.fileReceiverMaxSizeCurrent")}:{" "}
                  {formatFileSize(fileReceiverRuntime?.maxFileSizeBytes ?? parseFileReceiverMaxFileSizeBytes(fileReceiverMaxFileSizeMb))}
                </p>
                <p>
                  {t("settings.fileReceiverTtlCurrent")}:{" "}
                  {fileReceiverRuntime?.uploadTtlHours ?? parseFileReceiverUploadTtlHours(fileReceiverUploadTtlHours)}h
                </p>
                {fileReceiverRuntime?.lastError && (
                  <p className="text-red-600">{fileReceiverRuntime.lastError}</p>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-4 border-t pt-4">
        <p className="text-xs text-muted-foreground">
          {saved ? t("settings.savedTick") : t("settings.changeHint")}
        </p>
        <Button onClick={handleSave}>
          {saved ? t("settings.saved") : t("settings.save")}
        </Button>
      </div>
    </div>
  )
}

function formatRuntimeStatus(status: string): string {
  return status
    .split("_")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ")
}

function parseMcpPort(value: string): number {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) return 18765
  const port = Number(normalized)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 18765
  return port
}

function parseFileReceiverMaxFileSizeBytes(value: string): number {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) return 1024 * 1024 * 1024
  const megabytes = Number(normalized)
  if (!Number.isInteger(megabytes) || megabytes < 1) return 1024 * 1024 * 1024
  return megabytes * 1024 * 1024
}

function parseFileReceiverUploadTtlHours(value: string): number {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) return 24 * 7
  const hours = Number(normalized)
  if (!Number.isInteger(hours) || hours < 1) return 24 * 7
  return hours
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  return `${bytes} B`
}
