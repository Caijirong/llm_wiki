import { useState, useEffect } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import i18n from "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useChatStore } from "@/stores/chat-store"
import {
  fileReceiverUpdateConfig,
  fileReceiverUpdateKnownProjects,
  listDirectory,
  mcpUpdateConfig,
  mcpUpdateKnownProjects,
  mcpUpdateProject,
  openProject,
} from "@/commands/fs"
import {
  getLastProject,
  getRecentProjects,
  saveLastProject,
  loadLlmConfig,
  loadLanguage,
  loadSearchApiConfig,
  loadEmbeddingConfig,
  loadMultimodalConfig,
  loadOutputLanguage,
  loadProviderConfigs,
  loadActivePresetId,
  loadFileReceiverConfig,
  loadMcpConfig,
  saveFileReceiverConfig,
} from "@/lib/project-store"
import { normalizeFileReceiverConfigForMcp } from "@/lib/runtime-service-config"
import { loadReviewItems, loadChatHistory } from "@/lib/persist"
import { APP_RELEASE_REPO, APP_RELEASES_URL } from "@/lib/app-release"
import { setupAutoSave } from "@/lib/auto-save"
import { startClipWatcher } from "@/lib/clip-watcher"
import { AppLayout } from "@/components/layout/app-layout"
import { WelcomeScreen } from "@/components/project/welcome-screen"
import { CreateProjectDialog } from "@/components/project/create-project-dialog"
import type { WikiProject } from "@/types/wiki"
import type { FileReceiverConfig } from "@/stores/wiki-store"

function App() {
  const project = useWikiStore((s) => s.project)
  const mcpConfig = useWikiStore((s) => s.mcpConfig)
  const fileReceiverConfig = useWikiStore((s) => s.fileReceiverConfig)
  const setProject = useWikiStore((s) => s.setProject)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [loading, setLoading] = useState(true)
  const [mcpConfigLoaded, setMcpConfigLoaded] = useState(false)
  const [fileReceiverConfigLoaded, setFileReceiverConfigLoaded] = useState(false)

  async function syncKnownProjectsToServices(projects: WikiProject[]) {
    const paths = projects.map((p) => p.path)
    await Promise.all([
      mcpUpdateKnownProjects(paths),
      fileReceiverUpdateKnownProjects(paths),
    ])
  }

  // Set up auto-save and clip watcher once on mount
  useEffect(() => {
    setupAutoSave()
    startClipWatcher()
    let cancelled = false
    let stopRetrievalBridge: (() => void) | undefined
    import("@/lib/mcp-retrieval-bridge")
      .then(({ startMcpRetrievalBridge }) => startMcpRetrievalBridge())
      .then((stop) => {
        if (cancelled) {
          stop()
          return
        }
        stopRetrievalBridge = stop
      })
      .catch((err) => {
        console.error("Failed to start MCP retrieval bridge:", err)
      })
    return () => {
      cancelled = true
      stopRetrievalBridge?.()
    }
  }, [])

  useEffect(() => {
    if (!mcpConfigLoaded) return

    mcpUpdateConfig(mcpConfig).catch((err) => {
      console.error("Failed to sync MCP config to Tauri:", err)
    })
  }, [
    mcpConfigLoaded,
    mcpConfig.autoStart,
    mcpConfig.enabled,
    mcpConfig.host,
    mcpConfig.port,
  ])

  useEffect(() => {
    if (!fileReceiverConfigLoaded) return

    fileReceiverUpdateConfig(fileReceiverConfig).catch((err) => {
      console.error("Failed to sync file receiver config to Tauri:", err)
    })
  }, [
    fileReceiverConfigLoaded,
    fileReceiverConfig.autoStart,
    fileReceiverConfig.enabled,
    fileReceiverConfig.maxFileSizeBytes,
    fileReceiverConfig.staticToken,
    fileReceiverConfig.uploadTtlHours,
  ])

  // Dev-only helper for visually testing the update-banner UX.
  // Open dev tools and run:
  //   __llmwiki_testUpdateBanner()
  // to inject a fake "available" result into the update store —
  // banner appears at the top + red dot lights up the gear icon.
  // Run again with arg `false` (or call setDismissed via the store)
  // to clear. Gated on `import.meta.env.DEV` so the helper never
  // ships in production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(async () => {
      const storeMod = await import("@/stores/update-store")
      const { useUpdateStore } = storeMod
      // Expose the live store getter on window so you can inspect
      // state from devtools when debugging banner behavior.
      ;(window as unknown as { __llmwiki_updateStore?: typeof useUpdateStore }).__llmwiki_updateStore = useUpdateStore
      ;(window as unknown as { __llmwiki_testUpdateBanner?: (clear?: boolean) => void }).__llmwiki_testUpdateBanner = (clear = false) => {
        if (clear) {
          useUpdateStore.getState().setResult(
            { kind: "up-to-date", local: __APP_VERSION__, remote: __APP_VERSION__ },
            Date.now(),
          )
          useUpdateStore.getState().setDismissed(null)
          console.log("[test] update banner cleared")
          return
        }
        useUpdateStore.getState().setResult(
          {
            kind: "available",
            local: __APP_VERSION__,
            remote: "v999.0.0",
            release: {
              name: "v999.0.0 (test)",
              tag_name: "v999.0.0",
              body:
                "Test release for banner-UX verification.\n\n" +
                "- Bigger red dot on the Settings icon\n" +
                "- Top banner with one-click dismiss\n" +
                "- Once dismissed, won't reappear for this version",
              html_url: APP_RELEASES_URL,
              published_at: new Date().toISOString(),
            },
          },
          Date.now(),
        )
        useUpdateStore.getState().setDismissed(null)
        console.log(
          "[test] update banner injected. Run __llmwiki_testUpdateBanner(true) to clear.",
        )
      }
    })()
  }, [])

  // Background update check — hydrate persisted user preferences, then
  // hit GitHub at most once every UPDATE_CHECK_CACHE_MS. Runs 1.5 s
  // after mount so it doesn't contend with the heaviest startup work
  // (project load, file tree, vector store init) but still surfaces
  // a new release in time for the user to notice it during their
  // first interaction. Silent on failure; the UI in Settings → About
  // lets the user retry manually.
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      if (cancelled) return
      try {
        const { loadUpdateCheckState, saveUpdateCheckState } = await import(
          "@/lib/project-store"
        )
        const { useUpdateStore } = await import("@/stores/update-store")
        const { checkForUpdates, UPDATE_CHECK_CACHE_MS } = await import(
          "@/lib/update-check"
        )

        const persisted = await loadUpdateCheckState()
        if (persisted) useUpdateStore.getState().hydrate(persisted)

        const state = useUpdateStore.getState()
        if (!state.enabled) {
          console.log("[update-check] skipped: user disabled auto-check in settings")
          return
        }

        const now = Date.now()
        // Cache hit requires BOTH the timestamp AND the in-memory
        // result to be present. `lastCheckedAt` is persisted to
        // disk but `lastResult` deliberately is not — keeping the
        // GitHub payload out of the persisted store keeps disk
        // size + privacy footprint small. The downside: a fresh
        // cold start has `lastResult === null` even when
        // `lastCheckedAt` is recent, in which case we MUST refetch
        // — otherwise we'd skip the check AND have no result to
        // display, leaving the banner permanently stuck off.
        // (This was the user-reported bug: "kind=none, no banner".)
        const fresh =
          state.lastCheckedAt !== null &&
          state.lastResult !== null &&
          now - state.lastCheckedAt < UPDATE_CHECK_CACHE_MS
        if (fresh) {
          const ageMin = Math.round((now - (state.lastCheckedAt ?? 0)) / 60_000)
          console.log(
            `[update-check] skipped: cache hit (last check ${ageMin} min ago, ` +
              `cache window ${UPDATE_CHECK_CACHE_MS / 60_000} min). ` +
              `Last result: kind=${state.lastResult?.kind ?? "none"}`,
          )
          return
        }

        useUpdateStore.getState().setChecking(true)
        console.log(
          `[update-check] fetching GitHub releases (local=${__APP_VERSION__})`,
        )
        const result = await checkForUpdates({
          currentVersion: __APP_VERSION__,
          repo: APP_RELEASE_REPO,
        })
        if (cancelled) return
        useUpdateStore.getState().setResult(result, Date.now())
        if (result.kind === "available") {
          console.log(
            `[update-check] update available: local=${result.local} → remote=${result.remote}`,
          )
        } else if (result.kind === "up-to-date") {
          console.log(
            `[update-check] up to date: local=${result.local}, remote latest=${result.remote}`,
          )
        } else {
          console.log(`[update-check] error: ${result.message}`)
        }
        await saveUpdateCheckState({
          enabled: useUpdateStore.getState().enabled,
          lastCheckedAt: Date.now(),
          dismissedVersion: useUpdateStore.getState().dismissedVersion,
        })
      } catch {
        // Silent — Settings → About lets the user retry manually.
      }
    }, 1500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  // Auto-open last project on startup
  useEffect(() => {
    async function init() {
      try {
        const savedConfig = await loadLlmConfig()
        if (savedConfig) {
          useWikiStore.getState().setLlmConfig(savedConfig)
        }
        const savedProviderConfigs = await loadProviderConfigs()
        if (savedProviderConfigs) {
          useWikiStore.getState().setProviderConfigs(savedProviderConfigs)
        }
        const savedActivePreset = await loadActivePresetId()
        if (savedActivePreset) {
          useWikiStore.getState().setActivePresetId(savedActivePreset)
          // Re-resolve the active preset's LlmConfig from (preset defaults
          // + saved overrides). Without this, preset default updates
          // (e.g. a corrected Anthropic model ID shipped in a release)
          // never reach users who are relying on defaults — their stored
          // `llmConfig` snapshot from a previous launch would keep the
          // old value. Overrides still win, so an explicit user choice
          // is preserved.
          const { LLM_PRESETS } = await import("@/components/settings/llm-presets")
          const { resolveConfig } = await import("@/components/settings/preset-resolver")
          const preset = LLM_PRESETS.find((p) => p.id === savedActivePreset)
          if (preset) {
            const currentFallback = useWikiStore.getState().llmConfig
            const override = (savedProviderConfigs ?? {})[savedActivePreset]
            const resolved = resolveConfig(preset, override, currentFallback)
            useWikiStore.getState().setLlmConfig(resolved)
            const { saveLlmConfig } = await import("@/lib/project-store")
            await saveLlmConfig(resolved)
          }
        }
        const savedSearchConfig = await loadSearchApiConfig()
        if (savedSearchConfig) {
          useWikiStore.getState().setSearchApiConfig(savedSearchConfig)
        }
        const savedEmbeddingConfig = await loadEmbeddingConfig()
        if (savedEmbeddingConfig) {
          useWikiStore.getState().setEmbeddingConfig(savedEmbeddingConfig)
        }
        const savedMultimodalConfig = await loadMultimodalConfig()
        if (savedMultimodalConfig) {
          useWikiStore.getState().setMultimodalConfig(savedMultimodalConfig)
        }
        const savedMcpConfig = await loadMcpConfig()
        if (savedMcpConfig) {
          useWikiStore.getState().setMcpConfig(savedMcpConfig)
        }
        setMcpConfigLoaded(true)
        const savedFileReceiverConfig = await loadFileReceiverConfig()
        const normalizedFileReceiverConfig = normalizeFileReceiverConfigForMcp(
          useWikiStore.getState().mcpConfig,
          savedFileReceiverConfig,
        )
        useWikiStore.getState().setFileReceiverConfig(normalizedFileReceiverConfig)
        if (hasFileReceiverConfigChanged(savedFileReceiverConfig, normalizedFileReceiverConfig)) {
          try {
            await saveFileReceiverConfig(normalizedFileReceiverConfig)
          } catch (err) {
            console.error("Failed to persist normalized file receiver config:", err)
          }
        }
        setFileReceiverConfigLoaded(true)
        const recentProjects = await getRecentProjects()
        try {
          await syncKnownProjectsToServices(recentProjects)
        } catch (err) {
          console.error("Failed to sync known projects to Tauri services:", err)
        }
        const savedOutputLang = await loadOutputLanguage()
        if (savedOutputLang) {
          useWikiStore.getState().setOutputLanguage(savedOutputLang)
        }
        const savedLang = await loadLanguage()
        if (savedLang) {
          await i18n.changeLanguage(savedLang)
        }
        const lastProject = await getLastProject()
        if (lastProject) {
          try {
            const proj = await openProject(lastProject.path)
            await handleProjectOpened(proj)
          } catch {
            // Last project no longer valid
          }
        }
      } catch (err) {
        console.error("App initialization failed:", err)
        setMcpConfigLoaded(true)
        setFileReceiverConfigLoaded(true)
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [])

  async function handleProjectOpened(proj: WikiProject) {
    // Clear all per-project state BEFORE loading new project data
    // to prevent cross-project contamination. MUST be awaited so the
    // ingest queue / graph cache are actually cleared before the new
    // project's state is populated.
    const { resetProjectState } = await import("@/lib/reset-project-state")
    await resetProjectState()

    setProject(proj)
    setSelectedFile(null)
    setActiveView("wiki")
    // Bump data version so any cached graphs/views invalidate
    useWikiStore.getState().bumpDataVersion()
    await saveLastProject(proj)

    // Restore ingest queue (resume interrupted tasks). Keyed by the
    // project's stable UUID so the queue still finds the right project
    // even if the filesystem path changed since the task was enqueued.
    import("@/lib/ingest-queue").then(({ restoreQueue }) => {
      restoreQueue(proj.id, proj.path).catch((err) =>
        console.error("Failed to restore ingest queue:", err)
      )
    })
    mcpUpdateProject(proj.path).catch((err) => {
      console.error(`Failed to sync MCP current project (${proj.path}) to Tauri:`, err)
    })
    // Notify local clip server of the current project + all recent projects
    fetch("http://127.0.0.1:19827/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: proj.path }),
    }).catch(() => {})

    // Send all recent projects to clip server for extension project picker
    getRecentProjects().then((recents) => {
      const projects = recents.map((p) => ({ name: p.name, path: p.path }))
      syncKnownProjectsToServices(recents).catch((err) => {
        console.error("Failed to sync known projects to Tauri services:", err)
      })
      fetch("http://127.0.0.1:19827/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projects }),
      }).catch(() => {})
    }).catch(() => {})
    try {
      const tree = await listDirectory(proj.path)
      setFileTree(tree)
    } catch (err) {
      console.error("Failed to load file tree:", err)
    }
    // Load persisted review items
    try {
      const savedReview = await loadReviewItems(proj.path)
      if (savedReview.length > 0) {
        useReviewStore.getState().setItems(savedReview)
      }
    } catch {
      // ignore, start fresh
    }
    // Load persisted chat history
    try {
      const savedChat = await loadChatHistory(proj.path)
      if (savedChat.conversations.length > 0) {
        useChatStore.getState().setConversations(savedChat.conversations)
        useChatStore.getState().setMessages(savedChat.messages)
        // Set most recent conversation as active
        const sorted = [...savedChat.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
        if (sorted[0]) {
          useChatStore.getState().setActiveConversation(sorted[0].id)
        }
      }
    } catch {
      // ignore, start fresh
    }
  }

  async function handleSelectRecent(proj: WikiProject) {
    try {
      const validated = await openProject(proj.path)
      await handleProjectOpened(validated)
    } catch (err) {
      window.alert(`Failed to open project: ${err}`)
    }
  }

  async function handleOpenProject() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open Wiki Project",
    })
    if (!selected) return
    try {
      const proj = await openProject(selected)
      await handleProjectOpened(proj)
    } catch (err) {
      window.alert(`Failed to open project: ${err}`)
    }
  }

  async function handleSwitchProject() {
    mcpUpdateProject(null).catch((err) => {
      console.error("Failed to clear MCP current project in Tauri:", err)
    })
    // Clear all per-project state BEFORE flipping back to the welcome screen
    // so old data cannot leak in via any async render pass.
    const { resetProjectState } = await import("@/lib/reset-project-state")
    await resetProjectState()
    setProject(null)
    setFileTree([])
    setSelectedFile(null)
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        Loading...
      </div>
    )
  }

  if (!project) {
    return (
      <>
        <WelcomeScreen
          onCreateProject={() => setShowCreateDialog(true)}
          onOpenProject={handleOpenProject}
          onSelectProject={handleSelectRecent}
        />
        <CreateProjectDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          onCreated={handleProjectOpened}
        />
      </>
    )
  }

  return (
    <>
      <AppLayout onSwitchProject={handleSwitchProject} />
      <CreateProjectDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreated={handleProjectOpened}
      />
    </>
  )
}

export default App

function hasFileReceiverConfigChanged(
  savedConfig: FileReceiverConfig | null,
  normalizedConfig: FileReceiverConfig,
): boolean {
  if (!savedConfig) return true

  return (
    savedConfig.enabled !== normalizedConfig.enabled ||
    savedConfig.autoStart !== normalizedConfig.autoStart ||
    savedConfig.staticToken !== normalizedConfig.staticToken ||
    savedConfig.maxFileSizeBytes !== normalizedConfig.maxFileSizeBytes ||
    savedConfig.uploadTtlHours !== normalizedConfig.uploadTtlHours
  )
}
