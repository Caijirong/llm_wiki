// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { saveMcpConfig, loadMcpConfig } = vi.hoisted(() => ({
  saveMcpConfig: vi.fn(async () => {}),
  loadMcpConfig: vi.fn(async () => ({
    enabled: true,
    autoStart: false,
    host: "127.0.0.1",
    port: 18765,
  })),
}))

const { mcpStatus } = vi.hoisted(() => ({
  mcpStatus: vi.fn(async () => ({
    status: "stopped",
    host: "127.0.0.1",
    port: 18765,
    currentProject: null,
    knownProjects: [],
    lastError: null,
  })),
}))

vi.mock("@/commands/fs", () => ({
  mcpStatus,
}))

vi.mock("@/lib/project-store", () => ({
  saveLanguage: vi.fn(async () => {}),
  saveLlmConfig: vi.fn(async () => {}),
  saveSearchApiConfig: vi.fn(async () => {}),
  saveEmbeddingConfig: vi.fn(async () => {}),
  saveMcpConfig,
  loadMcpConfig,
}))

import { SettingsView } from "./settings-view"

describe("SettingsView MCP settings", () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    saveMcpConfig.mockClear()
    loadMcpConfig.mockReset()
    mcpStatus.mockClear()
    loadMcpConfig.mockResolvedValue({
      enabled: true,
      autoStart: false,
      host: "127.0.0.1",
      port: 18765,
    })
  })

  it("renders and saves mcp settings", async () => {
    let resolveLoad: ((value: { enabled: boolean; autoStart: boolean; host: string; port: number }) => void) | null = null
    loadMcpConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        })
    )

    const user = userEvent.setup()
    render(<SettingsView />)

    expect(screen.getByText(/MCP Server/i)).toBeInTheDocument()
    await user.click(screen.getByLabelText(/Enable MCP/i))
    await user.click(screen.getByLabelText(/Auto-start MCP/i))
    await user.clear(screen.getByLabelText(/Port/i))
    await user.type(screen.getByLabelText(/Port/i), "18765")
    resolveLoad?.({ enabled: false, autoStart: false, host: "0.0.0.0", port: 12345 })
    await waitFor(() => expect(loadMcpConfig).toHaveBeenCalled())
    await user.click(screen.getByRole("button", { name: /save settings/i }))

    expect(saveMcpConfig).toHaveBeenCalledWith({
      enabled: true,
      autoStart: true,
      host: "127.0.0.1",
      port: 18765,
    })
    expect(screen.getByText(/http:\/\/127\.0\.0\.1:18765\/mcp/i)).toBeInTheDocument()
  })

  it("falls back to default port when port is invalid", async () => {
    const user = userEvent.setup()
    render(<SettingsView />)
    const autoStartToggle = screen.getByLabelText(/Auto-start MCP/i) as HTMLInputElement
    await waitFor(() => expect(autoStartToggle.checked).toBe(false))

    await user.clear(screen.getByLabelText(/Port/i))
    await user.type(screen.getByLabelText(/Port/i), "70000")
    await user.click(screen.getByRole("button", { name: /save settings/i }))

    expect(saveMcpConfig).toHaveBeenCalledWith({
      enabled: true,
      autoStart: false,
      host: "127.0.0.1",
      port: 18765,
    })
  })
})
