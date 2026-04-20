// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const {
  persistedMcpConfig,
  loadMcpConfig,
  mcpUpdateConfig,
  mcpUpdateKnownProjects,
  mcpUpdateProject,
  openProject,
} = vi.hoisted(() => ({
  persistedMcpConfig: {
    enabled: true,
    autoStart: false,
    host: "127.0.0.1",
    port: 18765,
  },
  loadMcpConfig: vi.fn(async () => ({
    enabled: true,
    autoStart: false,
    host: "127.0.0.1",
    port: 18765,
  })),
  mcpUpdateConfig: vi.fn(async () => {}),
  mcpUpdateKnownProjects: vi.fn(async () => {}),
  mcpUpdateProject: vi.fn(async () => {}),
  openProject: vi.fn(async (path: string) => ({
    name: "Demo Project",
    path,
  })),
}))

vi.mock("@/i18n", () => ({
  default: {
    changeLanguage: vi.fn(async () => {}),
  },
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async () => []),
  openProject,
  mcpUpdateProject,
  mcpUpdateKnownProjects,
  mcpUpdateConfig,
}))

vi.mock("@/lib/project-store", () => ({
  getLastProject: vi.fn(async () => ({ name: "Demo Project", path: "/tmp/wiki" })),
  getRecentProjects: vi.fn(async () => [{ name: "Demo Project", path: "/tmp/wiki" }]),
  saveLastProject: vi.fn(async () => {}),
  loadLlmConfig: vi.fn(async () => null),
  loadSearchApiConfig: vi.fn(async () => null),
  loadEmbeddingConfig: vi.fn(async () => null),
  loadLanguage: vi.fn(async () => null),
  loadMcpConfig,
}))

vi.mock("@/lib/persist", () => ({
  loadReviewItems: vi.fn(async () => []),
  loadChatHistory: vi.fn(async () => ({ conversations: [], messages: [] })),
}))

vi.mock("@/lib/auto-save", () => ({
  setupAutoSave: vi.fn(() => {}),
}))

vi.mock("@/lib/clip-watcher", () => ({
  startClipWatcher: vi.fn(() => {}),
}))

vi.mock("@/components/layout/app-layout", () => ({
  AppLayout: () => null,
}))

vi.mock("@/components/project/welcome-screen", () => ({
  WelcomeScreen: () => null,
}))

vi.mock("@/components/project/create-project-dialog", () => ({
  CreateProjectDialog: () => null,
}))

import App from "./App"

describe("App MCP startup sync", () => {
  it("loads mcp config on startup and syncs the opened project to tauri", async () => {
    render(<App />)
    await waitFor(() => expect(loadMcpConfig).toHaveBeenCalled())
    await waitFor(() =>
      expect(mcpUpdateConfig).toHaveBeenCalledWith(persistedMcpConfig)
    )
    await waitFor(() =>
      expect(mcpUpdateProject).toHaveBeenCalledWith("/tmp/wiki")
    )
    await waitFor(() =>
      expect(mcpUpdateKnownProjects).toHaveBeenCalledWith(["/tmp/wiki"])
    )
    expect(loadMcpConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mcpUpdateConfig.mock.invocationCallOrder[0]
    )
  })
})
