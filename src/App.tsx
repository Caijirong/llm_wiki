import { useState, useEffect } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import i18n from "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useChatStore } from "@/stores/chat-store"
import {
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
  loadMcpConfig,
} from "@/lib/project-store"
import { loadReviewItems, loadChatHistory } from "@/lib/persist"
import { setupAutoSave } from "@/lib/auto-save"
import { startClipWatcher } from "@/lib/clip-watcher"
import { AppLayout } from "@/components/layout/app-layout"
import { WelcomeScreen } from "@/components/project/welcome-screen"
import { CreateProjectDialog } from "@/components/project/create-project-dialog"
import type { WikiProject } from "@/types/wiki"

function App() {
  const project = useWikiStore((s) => s.project)
  const mcpConfig = useWikiStore((s) => s.mcpConfig)
  const setProject = useWikiStore((s) => s.setProject)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [loading, setLoading] = useState(true)
  const [mcpConfigLoaded, setMcpConfigLoaded] = useState(false)

  async function syncMcpConfigOnInit() {
    const savedMcpConfig = await loadMcpConfig()
    if (savedMcpConfig) {
      useWikiStore.getState().setMcpConfig(savedMcpConfig)
    }
    setMcpConfigLoaded(true)
  }

  // Set up auto-save and clip watcher once on mount
  useEffect(() => {
    setupAutoSave()
    startClipWatcher()
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

  // Auto-open last project on startup
  useEffect(() => {
    async function init() {
      try {
        const savedConfig = await loadLlmConfig()
        if (savedConfig) {
          useWikiStore.getState().setLlmConfig(savedConfig)
        }
        const savedSearchConfig = await loadSearchApiConfig()
        if (savedSearchConfig) {
          useWikiStore.getState().setSearchApiConfig(savedSearchConfig)
        }
        const savedEmbeddingConfig = await loadEmbeddingConfig()
        if (savedEmbeddingConfig) {
          useWikiStore.getState().setEmbeddingConfig(savedEmbeddingConfig)
        }
        await syncMcpConfigOnInit()
        const savedLang = await loadLanguage()
        if (savedLang) {
          await i18n.changeLanguage(savedLang)
        }
        const lastProject = await getLastProject()
        if (lastProject) {
          try {
            const proj = await openProject(lastProject.path)
            await handleProjectOpened(proj)
          } catch (err) {
            console.error(
              `Failed to auto-open last project (${lastProject.path}); continuing without active project:`,
              err
            )
          }
        }
      } catch (err) {
        console.error("App initialization failed (including MCP startup sync):", err)
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [])

  async function handleProjectOpened(proj: WikiProject) {
    setProject(proj)
    setSelectedFile(null)
    setActiveView("wiki")
    await saveLastProject(proj)

    // Restore ingest queue (resume interrupted tasks)
    import("@/lib/ingest-queue").then(({ restoreQueue }) => {
      restoreQueue(proj.path).catch((err) =>
        console.error("Failed to restore ingest queue:", err)
      )
    })
    // Notify local clip server of the current project + all recent projects
    mcpUpdateProject(proj.path).catch((err) => {
      console.error(`Failed to sync MCP current project (${proj.path}) to Tauri:`, err)
    })
    fetch("http://127.0.0.1:19827/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: proj.path }),
    }).catch(() => {})

    // Send all recent projects to clip server for extension project picker
    getRecentProjects().then((recents) => {
      const projects = recents.map((p) => ({ name: p.name, path: p.path }))
      const paths = recents.map((p) => p.path)
      mcpUpdateKnownProjects(paths).catch((err) => {
        console.error("Failed to sync MCP known projects to Tauri:", err)
      })
      fetch("http://127.0.0.1:19827/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projects }),
      }).catch(() => {})
    }).catch((err) => {
      console.error("Failed to load recent projects for MCP/clip sync:", err)
    })
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

  function handleSwitchProject() {
    mcpUpdateProject(null).catch((err) => {
      console.error("Failed to clear MCP current project in Tauri:", err)
    })
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
