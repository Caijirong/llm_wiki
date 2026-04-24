// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { saveMcpConfig, loadMcpConfig, saveFileReceiverConfig, loadFileReceiverConfig } = vi.hoisted(() => ({
  saveMcpConfig: vi.fn(async () => {}),
  loadMcpConfig: vi.fn(async () => ({
    enabled: true,
    autoStart: false,
    host: "127.0.0.1",
    port: 18765,
  })),
  saveFileReceiverConfig: vi.fn(async () => {}),
  loadFileReceiverConfig: vi.fn(async () => ({
    enabled: true,
    autoStart: true,
    staticToken: "secret",
    maxFileSizeBytes: 1024 * 1024 * 1024,
    uploadTtlHours: 168,
  })),
}))

const { mcpStatus, fileReceiverStatus } = vi.hoisted(() => ({
  mcpStatus: vi.fn(async () => ({
    status: "stopped",
    host: "127.0.0.1",
    port: 18765,
    currentProject: null,
    knownProjects: [],
    lastError: null,
  })),
  fileReceiverStatus: vi.fn(async () => ({
    status: "running",
    host: "127.0.0.1",
    port: 18765,
    knownProjects: ["/tmp/wiki"],
    lastError: null,
    maxFileSizeBytes: 1024 * 1024 * 1024,
    uploadTtlHours: 168,
  })),
}))

vi.mock("@/commands/fs", () => ({
  mcpStatus,
  fileReceiverStatus,
}))

vi.mock("@/lib/project-store", () => ({
  saveLanguage: vi.fn(async () => {}),
  saveLlmConfig: vi.fn(async () => {}),
  saveSearchApiConfig: vi.fn(async () => {}),
  saveEmbeddingConfig: vi.fn(async () => {}),
  saveMcpConfig,
  loadMcpConfig,
  saveFileReceiverConfig,
  loadFileReceiverConfig,
}))

import { SettingsView } from "./settings-view"
import { useWikiStore } from "@/stores/wiki-store"

describe("SettingsView MCP settings", () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    useWikiStore.setState({
      mcpConfig: {
        enabled: true,
        autoStart: true,
        host: "127.0.0.1",
        port: 18765,
      },
      fileReceiverConfig: {
        enabled: false,
        autoStart: false,
        staticToken: "",
        maxFileSizeBytes: 1024 * 1024 * 1024,
        uploadTtlHours: 168,
      },
    })
    saveMcpConfig.mockClear()
    loadMcpConfig.mockReset()
    saveFileReceiverConfig.mockClear()
    loadFileReceiverConfig.mockReset()
    mcpStatus.mockClear()
    fileReceiverStatus.mockClear()
    loadMcpConfig.mockResolvedValue({
      enabled: true,
      autoStart: true,
      host: "127.0.0.1",
      port: 18765,
    })
    loadFileReceiverConfig.mockResolvedValue({
      enabled: false,
      autoStart: false,
      staticToken: "",
      maxFileSizeBytes: 1024 * 1024 * 1024,
      uploadTtlHours: 168,
    })
  })

  it("defaults mcp to enabled when no persisted config exists", async () => {
    loadMcpConfig.mockResolvedValueOnce(null)

    render(<SettingsView />)

    const enabledSwitch = screen.getByRole("switch", { name: /Enable MCP/i })
    await waitFor(() => expect(loadMcpConfig).toHaveBeenCalled())
    expect(enabledSwitch).toHaveAttribute("aria-checked", "true")
    expect(screen.getByLabelText(/Auto-start MCP/i)).toBeChecked()
    expect(screen.getByLabelText(/Host/i)).toBeInTheDocument()
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
    expect(screen.getByRole("switch", { name: /Enable MCP/i })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByLabelText(/Auto-start MCP/i)).toBeChecked()
    await user.click(screen.getByRole("switch", { name: /Enable MCP/i }))
    await waitFor(() =>
      expect(screen.queryByLabelText(/Auto-start MCP/i)).not.toBeInTheDocument()
    )
    resolveLoad?.({ enabled: false, autoStart: false, host: "0.0.0.0", port: 12345 })
    await waitFor(() => expect(loadMcpConfig).toHaveBeenCalled())
    await user.click(screen.getByRole("switch", { name: /Enable MCP/i }))
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /Enable MCP/i })).toHaveAttribute("aria-checked", "true")
    )
    expect(screen.getByLabelText(/Auto-start MCP/i)).toBeChecked()
    await user.click(screen.getByLabelText(/Auto-start MCP/i))
    await user.clear(screen.getByLabelText(/Port/i))
    await user.type(screen.getByLabelText(/Port/i), "18765")
    await user.click(screen.getByRole("button", { name: /save settings/i }))

    expect(saveMcpConfig).toHaveBeenCalledWith({
      enabled: true,
      autoStart: false,
      host: "127.0.0.1",
      port: 18765,
    })
    expect(screen.getByText(/http:\/\/127\.0\.0\.1:18765\/mcp/i)).toBeInTheDocument()
  })

  it("falls back to default port when port is invalid", async () => {
    const user = userEvent.setup()
    render(<SettingsView />)
    const autoStartCheckbox = screen.getByLabelText(/Auto-start MCP/i) as HTMLInputElement
    await waitFor(() =>
      expect(autoStartCheckbox.checked).toBe(true)
    )

    await user.clear(screen.getByLabelText(/Port/i))
    await user.type(screen.getByLabelText(/Port/i), "70000")
    await user.click(screen.getByRole("button", { name: /save settings/i }))

    expect(saveMcpConfig).toHaveBeenCalledWith({
      enabled: true,
      autoStart: true,
      host: "127.0.0.1",
      port: 18765,
    })
  })

  it("renders and saves file receiver settings", async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    expect(screen.getByText(/File Receiver/i)).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: /Enable file receiver/i })).toHaveAttribute("aria-checked", "false")

    await user.click(screen.getByRole("switch", { name: /Enable file receiver/i }))
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /Enable file receiver/i })).toHaveAttribute("aria-checked", "true")
    )

    await user.click(screen.getByLabelText(/Auto-start file receiver/i))
    await user.clear(screen.getByLabelText(/Static token/i))
    await user.type(screen.getByLabelText(/Static token/i), "team-secret")
    await user.clear(screen.getByLabelText(/Port/i, { selector: "#mcpPort" }))
    await user.type(screen.getByLabelText(/Port/i, { selector: "#mcpPort" }), "19090")
    await user.clear(screen.getByLabelText(/Max file size \(MB\)/i))
    await user.type(screen.getByLabelText(/Max file size \(MB\)/i), "2048")
    await user.clear(screen.getByLabelText(/Upload retention \(hours\)/i))
    await user.type(screen.getByLabelText(/Upload retention \(hours\)/i), "72")
    await user.click(screen.getByRole("button", { name: /save settings/i }))

    expect(saveFileReceiverConfig).toHaveBeenCalledWith({
      enabled: true,
      autoStart: true,
      staticToken: "team-secret",
      maxFileSizeBytes: 2048 * 1024 * 1024,
      uploadTtlHours: 72,
    })
    expect(screen.getByText(/http:\/\/127\.0\.0\.1:19090\/uploads/i)).toBeInTheDocument()
    expect(screen.getByText(/shares the same host and port as the MCP server/i)).toBeInTheDocument()
  })

  it("keeps shared host and port editable when only file receiver is enabled", async () => {
    useWikiStore.setState({
      mcpConfig: {
        enabled: false,
        autoStart: false,
        host: "0.0.0.0",
        port: 19090,
      },
      fileReceiverConfig: {
        enabled: true,
        autoStart: true,
        staticToken: "team-secret",
        maxFileSizeBytes: 1024 * 1024 * 1024,
        uploadTtlHours: 168,
      },
    })
    loadMcpConfig.mockResolvedValueOnce({
      enabled: false,
      autoStart: false,
      host: "0.0.0.0",
      port: 19090,
    })
    loadFileReceiverConfig.mockResolvedValueOnce({
      enabled: true,
      autoStart: true,
      staticToken: "team-secret",
      maxFileSizeBytes: 1024 * 1024 * 1024,
      uploadTtlHours: 168,
    })

    const user = userEvent.setup()
    render(<SettingsView />)

    await waitFor(() => expect(loadMcpConfig).toHaveBeenCalled())
    expect(screen.getByLabelText(/Host/i)).toHaveValue("0.0.0.0")
    expect(screen.getByLabelText(/Port/i)).toHaveValue(19090)
    expect(screen.getByText(/exposes MCP and uploads to your network/i)).toBeInTheDocument()

    await user.clear(screen.getByLabelText(/Port/i))
    await user.type(screen.getByLabelText(/Port/i), "19191")
    await user.click(screen.getByRole("button", { name: /save settings/i }))

    expect(saveMcpConfig).toHaveBeenCalledWith({
      enabled: false,
      autoStart: false,
      host: "0.0.0.0",
      port: 19191,
    })
  })
})
