import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import {
  fileReceiverStatus as fetchFileReceiverStatus,
  type FileReceiverStatus as FileReceiverRuntimeState,
  mcpStatus as fetchMcpStatus,
  type McpStatus as McpRuntimeStatus,
} from "@/commands/fs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useState, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import i18n from "@/i18n"
import { saveLanguage } from "@/lib/project-store"
import { normalizeFileReceiverConfigForMcp } from "@/lib/runtime-service-config"
import {
  testEmbeddingConnection,
  testLlmConnection,
  testSearchConnection,
  type ConnectionTestResult,
} from "@/lib/connection-tests"
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react"

const PROVIDERS = [
  { value: "openai" as const, label: "OpenAI", models: ["gpt-4o", "gpt-4.1", "gpt-4o-mini"] },
  { value: "anthropic" as const, label: "Anthropic", models: ["claude-sonnet-4-5-20250514", "claude-opus-4-5-20250514", "claude-haiku-4-5-20251001"] },
  { value: "google" as const, label: "Google", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { value: "minimax" as const, label: "MiniMax", models: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"] },
  { value: "ollama" as const, label: "Ollama (Local)", models: [] },
  { value: "custom" as const, label: "Custom", models: [] },
]

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
]

const HISTORY_OPTIONS = [2, 4, 6, 8, 10, 20]

type ConnectionTestState = {
  status: "idle" | "testing" | "success" | "error"
  message: string
}

const IDLE_CONNECTION_TEST_STATE: ConnectionTestState = {
  status: "idle",
  message: "",
}

export function SettingsView() {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setLlmConfig = useWikiStore((s) => s.setLlmConfig)
  const searchApiConfig = useWikiStore((s) => s.searchApiConfig)
  const setSearchApiConfig = useWikiStore((s) => s.setSearchApiConfig)
  const embeddingConfig = useWikiStore((s) => s.embeddingConfig)
  const setEmbeddingConfig = useWikiStore((s) => s.setEmbeddingConfig)
  const mcpConfig = useWikiStore((s) => s.mcpConfig)
  const setMcpConfig = useWikiStore((s) => s.setMcpConfig)
  const fileReceiverConfig = useWikiStore((s) => s.fileReceiverConfig)
  const setFileReceiverConfig = useWikiStore((s) => s.setFileReceiverConfig)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)
  const setMaxHistoryMessages = useChatStore((s) => s.setMaxHistoryMessages)

  const [provider, setProvider] = useState(llmConfig.provider)
  const [apiKey, setApiKey] = useState(llmConfig.apiKey)
  const [model, setModel] = useState(llmConfig.model)
  const [ollamaUrl, setOllamaUrl] = useState(llmConfig.ollamaUrl)
  const [customEndpoint, setCustomEndpoint] = useState(llmConfig.customEndpoint)
  const [maxContextSize, setMaxContextSize] = useState(llmConfig.maxContextSize ?? 204800)
  const [searchProvider, setSearchProvider] = useState(searchApiConfig.provider)
  const [searchApiKey, setSearchApiKey] = useState(searchApiConfig.apiKey)
  const [embeddingEnabled, setEmbeddingEnabled] = useState(embeddingConfig.enabled)
  const [embeddingEndpoint, setEmbeddingEndpoint] = useState(embeddingConfig.endpoint)
  const [embeddingApiKey, setEmbeddingApiKey] = useState(embeddingConfig.apiKey)
  const [embeddingModel, setEmbeddingModel] = useState(embeddingConfig.model)
  const [mcpEnabled, setMcpEnabled] = useState(mcpConfig.enabled)
  const [mcpAutoStart, setMcpAutoStart] = useState(mcpConfig.autoStart)
  const [mcpHost, setMcpHost] = useState(mcpConfig.host)
  const [mcpPort, setMcpPort] = useState(String(mcpConfig.port))
  const [mcpRuntime, setMcpRuntime] = useState<McpRuntimeStatus | null>(null)
  const [fileReceiverToken, setFileReceiverToken] = useState(fileReceiverConfig.staticToken)
  const [fileReceiverMaxFileSizeMb, setFileReceiverMaxFileSizeMb] = useState(
    String(Math.max(1, Math.round(fileReceiverConfig.maxFileSizeBytes / (1024 * 1024))))
  )
  const [fileReceiverUploadTtlHours, setFileReceiverUploadTtlHours] = useState(
    String(fileReceiverConfig.uploadTtlHours)
  )
  const [fileReceiverRuntime, setFileReceiverRuntime] = useState<FileReceiverRuntimeState | null>(null)
  const [saved, setSaved] = useState(false)
  const [currentLang, setCurrentLang] = useState(i18n.language)
  const [llmConnectionStatus, setLlmConnectionStatus] = useState<ConnectionTestState>(IDLE_CONNECTION_TEST_STATE)
  const [searchConnectionStatus, setSearchConnectionStatus] = useState<ConnectionTestState>(IDLE_CONNECTION_TEST_STATE)
  const [embeddingConnectionStatus, setEmbeddingConnectionStatus] = useState<ConnectionTestState>(IDLE_CONNECTION_TEST_STATE)
  const hasTouchedMcpSettings = useRef(false)
  const hasTouchedFileReceiverSettings = useRef(false)

  useEffect(() => {
    setProvider(llmConfig.provider)
    setApiKey(llmConfig.apiKey)
    setModel(llmConfig.model)
    setOllamaUrl(llmConfig.ollamaUrl)
    setCustomEndpoint(llmConfig.customEndpoint)
  }, [llmConfig])

  useEffect(() => {
    setSearchProvider(searchApiConfig.provider)
    setSearchApiKey(searchApiConfig.apiKey)
  }, [searchApiConfig])

  useEffect(() => {
    setLlmConnectionStatus(IDLE_CONNECTION_TEST_STATE)
  }, [provider, apiKey, model, ollamaUrl, customEndpoint])

  useEffect(() => {
    setSearchConnectionStatus(IDLE_CONNECTION_TEST_STATE)
  }, [searchProvider, searchApiKey])

  useEffect(() => {
    setEmbeddingConnectionStatus(IDLE_CONNECTION_TEST_STATE)
  }, [embeddingEnabled, embeddingEndpoint, embeddingApiKey, embeddingModel])

  useEffect(() => {
    setFileReceiverToken(fileReceiverConfig.staticToken)
    setFileReceiverMaxFileSizeMb(
      String(Math.max(1, Math.round(fileReceiverConfig.maxFileSizeBytes / (1024 * 1024))))
    )
    setFileReceiverUploadTtlHours(String(fileReceiverConfig.uploadTtlHours))
  }, [fileReceiverConfig])

  useEffect(() => {
    let mounted = true
    void (async () => {
      const { loadFileReceiverConfig, loadMcpConfig } = await import("@/lib/project-store")
      const [persistedMcp, persistedFileReceiver] = await Promise.all([
        loadMcpConfig(),
        loadFileReceiverConfig(),
      ])
      if (mounted && persistedMcp && !hasTouchedMcpSettings.current) {
        setMcpEnabled(persistedMcp.enabled)
        setMcpAutoStart(persistedMcp.autoStart)
        setMcpHost(persistedMcp.host)
        setMcpPort(String(persistedMcp.port))
      }
      if (mounted && persistedFileReceiver && !hasTouchedFileReceiverSettings.current) {
        setFileReceiverToken(persistedFileReceiver.staticToken.trim())
        setFileReceiverMaxFileSizeMb(
          String(Math.max(1, Math.round(persistedFileReceiver.maxFileSizeBytes / (1024 * 1024))))
        )
        setFileReceiverUploadTtlHours(String(persistedFileReceiver.uploadTtlHours))
      }
    })()

    return () => {
      mounted = false
    }
  }, [])

  async function refreshMcpRuntime() {
    try {
      setMcpRuntime(await fetchMcpStatus())
    } catch (err) {
      setMcpRuntime({
        status: "error",
        lastError: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function refreshFileReceiverRuntime() {
    try {
      setFileReceiverRuntime(await fetchFileReceiverStatus())
    } catch (err) {
      setFileReceiverRuntime({
        status: "error",
        host: mcpHost.trim() || "127.0.0.1",
        port: parseMcpPort(mcpPort),
        knownProjects: [],
        lastError: err instanceof Error ? err.message : String(err),
        maxFileSizeBytes: parseFileReceiverMaxFileSizeBytes(fileReceiverMaxFileSizeMb),
        uploadTtlHours: parseFileReceiverUploadTtlHours(fileReceiverUploadTtlHours),
      })
    }
  }

  useEffect(() => {
    let active = true

    const refresh = async () => {
      try {
        const [mcpRuntimeState, fileReceiverRuntimeState] = await Promise.all([
          fetchMcpStatus(),
          fetchFileReceiverStatus(),
        ])
        if (active) {
          setMcpRuntime(mcpRuntimeState)
          setFileReceiverRuntime(fileReceiverRuntimeState)
        }
      } catch (err) {
        if (active) {
          setMcpRuntime({
            status: "error",
            lastError: err instanceof Error ? err.message : String(err),
          })
          setFileReceiverRuntime({
            status: "error",
            host: mcpHost.trim() || "127.0.0.1",
            port: parseMcpPort(mcpPort),
            knownProjects: [],
            lastError: err instanceof Error ? err.message : String(err),
            maxFileSizeBytes: parseFileReceiverMaxFileSizeBytes(fileReceiverMaxFileSizeMb),
            uploadTtlHours: parseFileReceiverUploadTtlHours(fileReceiverUploadTtlHours),
          })
        }
      }
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

  const currentProvider = PROVIDERS.find((p) => p.value === provider)
  const mcpRuntimeLabel = mcpRuntime
    ? formatRuntimeStatus(mcpRuntime.status)
    : t("settings.mcpStatusPlaceholder")
  const sharedListenerSettingsVisible = mcpEnabled
  const sharedExternalHost = mcpHost.trim() || "127.0.0.1"
  const sharedExternalPort = parseMcpPort(mcpPort)
  const mcpEndpointPreview = `http://${sharedExternalHost}:${sharedExternalPort}/mcp`
  const fileReceiverRuntimeLabel = fileReceiverRuntime
    ? formatRuntimeStatus(fileReceiverRuntime.status)
    : t("settings.fileReceiverStatusPlaceholder")
  const fileReceiverEndpointPreview = `http://${sharedExternalHost}:${sharedExternalPort}/uploads`

  async function handleSave() {
    const {
      saveEmbeddingConfig,
      saveFileReceiverConfig,
      saveLlmConfig,
      saveMcpConfig,
      saveSearchApiConfig,
    } = await import("@/lib/project-store")
    const normalizedMcpPort = parseMcpPort(mcpPort)
    const normalizedMcpHost = mcpHost.trim() || "127.0.0.1"
    const newConfig = { provider, apiKey, model, ollamaUrl, customEndpoint, maxContextSize }
    const newSearchConfig = { provider: searchProvider, apiKey: searchApiKey }
    const newEmbeddingConfig = { enabled: embeddingEnabled, endpoint: embeddingEndpoint, apiKey: embeddingApiKey, model: embeddingModel }
    const newMcpConfig = { enabled: mcpEnabled, autoStart: mcpAutoStart, host: normalizedMcpHost, port: normalizedMcpPort }
    const newFileReceiverConfig = normalizeFileReceiverConfigForMcp(newMcpConfig, {
      enabled: mcpEnabled,
      autoStart: mcpAutoStart,
      staticToken: fileReceiverToken.trim(),
      maxFileSizeBytes: parseFileReceiverMaxFileSizeBytes(fileReceiverMaxFileSizeMb),
      uploadTtlHours: parseFileReceiverUploadTtlHours(fileReceiverUploadTtlHours),
    })
    setSearchApiConfig(newSearchConfig)
    await saveSearchApiConfig(newSearchConfig)
    setEmbeddingConfig(newEmbeddingConfig)
    await saveEmbeddingConfig(newEmbeddingConfig)
    setMcpConfig(newMcpConfig)
    await saveMcpConfig(newMcpConfig)
    setFileReceiverConfig(newFileReceiverConfig)
    setFileReceiverToken(newFileReceiverConfig.staticToken)
    await saveFileReceiverConfig(newFileReceiverConfig)
    setLlmConfig(newConfig)
    await saveLlmConfig(newConfig)
    await refreshMcpRuntime()
    await refreshFileReceiverRuntime()
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleLanguageChange(lang: string) {
    await i18n.changeLanguage(lang)
    setCurrentLang(lang)
    await saveLanguage(lang)
  }

  async function runConnectionTest(
    setStatus: (state: ConnectionTestState) => void,
    test: () => Promise<ConnectionTestResult>,
  ) {
    setStatus({ status: "testing", message: t("settings.testingConnection") })
    try {
      const result = await test()
      setStatus({
        status: "success",
        message: t("settings.connectionSuccess", { target: result.label }),
      })
    } catch (err) {
      setStatus({
        status: "error",
        message: t("settings.connectionFailed", { error: getErrorMessage(err) }),
      })
    }
  }

  async function handleTestLlmConnection() {
    await runConnectionTest(
      setLlmConnectionStatus,
      () => testLlmConnection({ provider, apiKey, model, ollamaUrl, customEndpoint, maxContextSize })
    )
  }

  async function handleTestSearchConnection() {
    await runConnectionTest(
      setSearchConnectionStatus,
      () => testSearchConnection({ provider: searchProvider, apiKey: searchApiKey })
    )
  }

  async function handleTestEmbeddingConnection() {
    await runConnectionTest(
      setEmbeddingConnectionStatus,
      () => testEmbeddingConnection({
        enabled: embeddingEnabled,
        endpoint: embeddingEndpoint,
        apiKey: embeddingApiKey,
        model: embeddingModel,
      })
    )
  }

  return (
    <div className="h-full overflow-auto p-8">
      <div className="mx-auto max-w-xl">
        <h2 className="mb-6 text-2xl font-bold">{t("settings.title")}</h2>

        <div className="space-y-6">
          {/* Language section */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">{t("settings.language")}</h3>
            <div className="flex flex-wrap gap-2">
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.value}
                  onClick={() => handleLanguageChange(lang.value)}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    currentLang === lang.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:bg-accent"
                  }`}
                >
                  {lang.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("settings.languageHint")}</p>
          </div>

          {/* LLM Provider section */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">{t("settings.llmProvider")}</h3>

            <div className="space-y-2">
              <Label>{t("settings.provider")}</Label>
              <div className="flex flex-wrap gap-2">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => {
                      setProvider(p.value)
                      setModel(p.models[0] || "")
                    }}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      provider === p.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {provider === "custom" && (
              <div className="space-y-2">
                <Label htmlFor="customEndpoint">{t("settings.customEndpoint")}</Label>
                <Input
                  id="customEndpoint"
                  value={customEndpoint}
                  onChange={(e) => setCustomEndpoint(e.target.value)}
                  placeholder="https://your-api.example.com/v1"
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.customEndpointHint")}
                </p>
              </div>
            )}

            {provider === "ollama" && (
              <div className="space-y-2">
                <Label htmlFor="ollamaUrl">{t("settings.ollamaUrl")}</Label>
                <Input
                  id="ollamaUrl"
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                />
              </div>
            )}

            {provider !== "ollama" && (
              <div className="space-y-2">
                <Label htmlFor="apiKey">{t("settings.apiKey")}</Label>
                <Input
                  id="apiKey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    provider === "custom"
                      ? t("settings.customApiKey")
                      : t("settings.apiKeyPlaceholder", { provider: currentProvider?.label })
                  }
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="model">{t("settings.model")}</Label>
              {currentProvider && currentProvider.models.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {currentProvider.models.map((m) => (
                      <button
                        key={m}
                        onClick={() => setModel(m)}
                        className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                          model === m
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-accent"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  <Input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={t("settings.customModel")}
                  />
                </div>
              ) : (
                <Input
                  id="model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={t("settings.modelPlaceholder")}
                />
              )}
            </div>

            <div className="space-y-2">
              <ConnectionTestButton
                label={t("settings.testLlmConnection")}
                loadingLabel={t("settings.testingConnection")}
                state={llmConnectionStatus}
                onClick={handleTestLlmConnection}
              />
              <ConnectionStatusMessage state={llmConnectionStatus} />
            </div>
          </div>

          {/* Context Window Size */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Context Window</h3>
            <p className="text-xs text-muted-foreground">
              Maximum context size sent to the LLM. Larger context allows more wiki pages in each query but costs more tokens.
            </p>

            <div className="space-y-3">
              <ContextSizeSelector value={maxContextSize} onChange={setMaxContextSize} />
            </div>
          </div>

          {/* Web Search API section */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Web Search (Deep Research)</h3>
            <p className="text-xs text-muted-foreground">
              Enable AI-powered web research to automatically find relevant sources for knowledge gaps.
            </p>

            <div className="space-y-2">
              <Label>Search Provider</Label>
              <div className="flex flex-wrap gap-2">
                {[
                  { value: "none" as const, label: "Disabled" },
                  { value: "tavily" as const, label: "Tavily" },
                ].map((p) => (
                  <button
                    key={p.value}
                    onClick={() => setSearchProvider(p.value)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      searchProvider === p.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {searchProvider !== "none" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="searchApiKey">API Key</Label>
                  <Input
                    id="searchApiKey"
                    type="password"
                    value={searchApiKey}
                    onChange={(e) => setSearchApiKey(e.target.value)}
                    placeholder="Enter your Tavily API key (tavily.com)"
                  />
                </div>

                <div className="space-y-2">
                  <ConnectionTestButton
                    label={t("settings.testSearchConnection")}
                    loadingLabel={t("settings.testingConnection")}
                    state={searchConnectionStatus}
                    onClick={handleTestSearchConnection}
                  />
                  <ConnectionStatusMessage state={searchConnectionStatus} />
                </div>
              </>
            )}
          </div>

          {/* Embedding Search section */}
          <div className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Vector Search (Embedding)</h3>
              <button
                onClick={() => setEmbeddingEnabled(!embeddingEnabled)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  embeddingEnabled ? "bg-primary" : "bg-muted"
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                    embeddingEnabled ? "translate-x-4.5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Enable semantic search using embeddings. Uses the same LLM provider endpoint. Improves search quality for synonym matching and cross-domain discovery.
            </p>
            {embeddingEnabled && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="embeddingEndpoint">Endpoint</Label>
                  <Input
                    id="embeddingEndpoint"
                    value={embeddingEndpoint}
                    onChange={(e) => setEmbeddingEndpoint(e.target.value)}
                    placeholder="e.g. http://127.0.0.1:1234/v1/embeddings"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="embeddingApiKey">API Key (optional)</Label>
                  <Input
                    id="embeddingApiKey"
                    type="password"
                    value={embeddingApiKey}
                    onChange={(e) => setEmbeddingApiKey(e.target.value)}
                    placeholder="Leave empty for local models"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="embeddingModel">Model</Label>
                  <Input
                    id="embeddingModel"
                    value={embeddingModel}
                    onChange={(e) => setEmbeddingModel(e.target.value)}
                    placeholder="e.g. text-embedding-qwen3-embedding-0.6b"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Embedding service can be different from the chat LLM. Supports any OpenAI-compatible /v1/embeddings endpoint.
                </p>
                <div className="space-y-2">
                  <ConnectionTestButton
                    label={t("settings.testEmbeddingConnection")}
                    loadingLabel={t("settings.testingConnection")}
                    state={embeddingConnectionStatus}
                    onClick={handleTestEmbeddingConnection}
                  />
                  <ConnectionStatusMessage state={embeddingConnectionStatus} />
                </div>
              </div>
            )}
          </div>

          {/* MCP Server section */}
          <div className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{t("settings.mcpServer")}</h3>
              <button
                id="mcpEnabled"
                type="button"
                role="switch"
                aria-checked={mcpEnabled}
                aria-label={t("settings.enableMcp")}
                onClick={() => {
                  hasTouchedMcpSettings.current = true
                  setMcpEnabled(!mcpEnabled)
                }}
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
            <p className="text-xs text-muted-foreground">{t("settings.mcpDescription")}</p>

            {mcpEnabled && (
              <div className="flex items-center gap-2">
                <input
                  id="mcpAutoStart"
                  type="checkbox"
                  checked={mcpAutoStart}
                  onChange={(e) => {
                    hasTouchedMcpSettings.current = true
                    setMcpAutoStart(e.target.checked)
                  }}
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
                      onChange={(e) => {
                        hasTouchedMcpSettings.current = true
                        setMcpHost(e.target.value)
                      }}
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
                      onChange={(e) => {
                        hasTouchedMcpSettings.current = true
                        setMcpPort(e.target.value)
                      }}
                      placeholder="18765"
                    />
                  </div>
                </div>

                {mcpHost.trim() === "0.0.0.0" && (
                  <p className="text-xs text-amber-600">{t("settings.mcpHostWarning")}</p>
                )}

                <div className="space-y-1 rounded-md bg-muted/40 p-3 text-xs">
                  <p>
                    {t("settings.mcpRuntimeStatus")}: {mcpRuntimeLabel}
                  </p>
                  <p>
                    {t("settings.mcpEndpointPreview")}: {mcpEndpointPreview}
                  </p>
                  {mcpRuntime?.currentProject && (
                    <p>Project: {mcpRuntime.currentProject}</p>
                  )}
                  {mcpRuntime?.lastError && (
                    <p className="text-red-600">{mcpRuntime.lastError}</p>
                  )}
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
                      onChange={(e) => {
                        hasTouchedFileReceiverSettings.current = true
                        setFileReceiverToken(e.target.value)
                      }}
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
                        onChange={(e) => {
                          hasTouchedFileReceiverSettings.current = true
                          setFileReceiverMaxFileSizeMb(e.target.value)
                        }}
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
                        onChange={(e) => {
                          hasTouchedFileReceiverSettings.current = true
                          setFileReceiverUploadTtlHours(e.target.value)
                        }}
                        placeholder="168"
                      />
                    </div>
                  </div>

                  <div className="space-y-1 rounded-md bg-muted/40 p-3 text-xs">
                    <p>
                      {t("settings.fileReceiverRuntimeStatus")}: {fileReceiverRuntimeLabel}
                    </p>
                    <p>
                      {t("settings.fileReceiverEndpointPreview")}: {fileReceiverEndpointPreview}
                    </p>
                    <p>
                      {t("settings.fileReceiverKnownProjects")}: {fileReceiverRuntime?.knownProjects.length ?? 0}
                    </p>
                    <p>
                      {t("settings.fileReceiverMaxSizeCurrent")}: {formatFileSize(fileReceiverRuntime?.maxFileSizeBytes ?? parseFileReceiverMaxFileSizeBytes(fileReceiverMaxFileSizeMb))}
                    </p>
                    <p>
                      {t("settings.fileReceiverTtlCurrent")}: {fileReceiverRuntime?.uploadTtlHours ?? parseFileReceiverUploadTtlHours(fileReceiverUploadTtlHours)}h
                    </p>
                    {fileReceiverRuntime?.lastError && (
                      <p className="text-red-600">{fileReceiverRuntime.lastError}</p>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Chat History section */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Chat History</h3>
            <p className="text-xs text-muted-foreground">
              Number of previous messages included when talking to AI. More = better context but uses more tokens.
            </p>
            <div className="space-y-2">
              <Label>Max conversation messages sent to AI</Label>
              <div className="flex flex-wrap gap-2">
                {HISTORY_OPTIONS.map((n) => (
                  <button
                    key={n}
                    onClick={() => setMaxHistoryMessages(n)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      maxHistoryMessages === n
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Currently: {maxHistoryMessages} messages ({maxHistoryMessages / 2} rounds of conversation)
              </p>
            </div>
          </div>

          <Button onClick={handleSave} className="w-full">
            {saved ? t("settings.saved") : t("settings.save")}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ConnectionTestButton({
  label,
  loadingLabel,
  state,
  onClick,
}: {
  label: string
  loadingLabel: string
  state: ConnectionTestState
  onClick: () => void
}) {
  const testing = state.status === "testing"

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={testing}
    >
      {testing ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <RefreshCw className="h-3.5 w-3.5" />
      )}
      {testing ? loadingLabel : label}
    </Button>
  )
}

function ConnectionStatusMessage({ state }: { state: ConnectionTestState }) {
  if (state.status === "idle") return null

  const Icon =
    state.status === "testing"
      ? Loader2
      : state.status === "success"
        ? CheckCircle2
        : AlertCircle
  const colorClass =
    state.status === "testing"
      ? "text-muted-foreground"
      : state.status === "success"
        ? "text-emerald-600"
        : "text-destructive"
  const role = state.status === "error" ? "alert" : "status"

  return (
    <p role={role} className={`flex items-start gap-1.5 text-xs ${colorClass}`}>
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${state.status === "testing" ? "animate-spin" : ""}`} />
      <span>{state.message}</span>
    </p>
  )
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Context size presets matching common model context windows
const CONTEXT_PRESETS = [
  { value: 4096, label: "4K" },
  { value: 8192, label: "8K" },
  { value: 16384, label: "16K" },
  { value: 32768, label: "32K" },
  { value: 65536, label: "64K" },
  { value: 131072, label: "128K" },
  { value: 204800, label: "200K" },
  { value: 262144, label: "256K" },
  { value: 524288, label: "512K" },
  { value: 1000000, label: "1M" },
]

function ContextSizeSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  // Find closest preset index
  const closestIndex = CONTEXT_PRESETS.reduce((best, preset, i) => {
    return Math.abs(preset.value - value) < Math.abs(CONTEXT_PRESETS[best].value - value) ? i : best
  }, 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium">{formatSize(value)}</span>
        <span className="text-xs text-muted-foreground">
          ~{Math.floor(value * 0.6 / 1000)}K chars for wiki content
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={CONTEXT_PRESETS.length - 1}
        step={1}
        value={closestIndex}
        onChange={(e) => onChange(CONTEXT_PRESETS[parseInt(e.target.value)].value)}
        className="w-full h-2 rounded-lg appearance-none cursor-pointer accent-primary"
        style={{ background: `linear-gradient(to right, #4f46e5 ${(closestIndex / (CONTEXT_PRESETS.length - 1)) * 100}%, #e5e7eb ${(closestIndex / (CONTEXT_PRESETS.length - 1)) * 100}%)` }}
      />
      <div className="flex justify-between mt-1">
        {CONTEXT_PRESETS.map((preset, i) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => onChange(preset.value)}
            className={`text-[9px] px-0.5 ${
              i === closestIndex ? "text-primary font-bold" : "text-muted-foreground/50"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function formatSize(chars: number): string {
  if (chars >= 1000000) return `${(chars / 1000000).toFixed(1)}M characters`
  if (chars >= 1000) return `${Math.round(chars / 1000)}K characters`
  return `${chars} characters`
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
