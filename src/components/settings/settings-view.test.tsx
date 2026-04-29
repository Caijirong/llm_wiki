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

const { testLlmConnection, testSearchConnection, testEmbeddingConnection } = vi.hoisted(() => ({
  testLlmConnection: vi.fn(async () => ({ label: "OpenAI (gpt-4o-mini)" })),
  testSearchConnection: vi.fn(async () => ({ label: "Tavily" })),
  testEmbeddingConnection: vi.fn(async () => ({ label: "text-embedding-test (3 dimensions)" })),
}))

vi.mock("@/commands/fs", () => ({
  mcpStatus,
  fileReceiverStatus,
}))

vi.mock("@/lib/connection-tests", () => ({
  testLlmConnection,
  testSearchConnection,
  testEmbeddingConnection,
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
      llmConfig: {
        provider: "openai",
        apiKey: "",
        model: "",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "",
        maxContextSize: 204800,
      },
      searchApiConfig: {
        provider: "none",
        apiKey: "",
      },
      embeddingConfig: {
        enabled: false,
        endpoint: "",
        apiKey: "",
        model: "",
      },
    })
    saveMcpConfig.mockClear()
    loadMcpConfig.mockReset()
    saveFileReceiverConfig.mockClear()
    loadFileReceiverConfig.mockReset()
    mcpStatus.mockClear()
    fileReceiverStatus.mockClear()
    testLlmConnection.mockClear()
    testSearchConnection.mockClear()
    testEmbeddingConnection.mockClear()
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
    expect(screen.queryByRole("switch", { name: /Enable file receiver/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Auto-start MCP/i)).toBeChecked()
    expect(screen.queryByLabelText(/Auto-start file receiver/i)).not.toBeInTheDocument()
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
    await user.clear(screen.getByLabelText(/Static token/i))
    await user.type(screen.getByLabelText(/Static token/i), "team-secret")
    await user.click(screen.getByRole("button", { name: /save settings/i }))

    expect(saveMcpConfig).toHaveBeenCalledWith({
      enabled: true,
      autoStart: false,
      host: "127.0.0.1",
      port: 18765,
    })
    expect(saveFileReceiverConfig).toHaveBeenCalledWith({
      enabled: true,
      autoStart: false,
      staticToken: "team-secret",
      maxFileSizeBytes: 1024 * 1024 * 1024,
      uploadTtlHours: 168,
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

  it("renders upload settings inside the MCP server panel", async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    expect(screen.getByText(/Upload Import/i)).toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: /Enable file receiver/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Auto-start file receiver/i)).not.toBeInTheDocument()
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
    expect(screen.getByText(/Uploads are available whenever MCP is enabled/i)).toBeInTheDocument()
  })

  it("hides upload settings when MCP is disabled", async () => {
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
    expect(screen.queryByLabelText(/Host/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Static token/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /save settings/i }))

    expect(saveMcpConfig).toHaveBeenCalledWith({
      enabled: false,
      autoStart: false,
      host: "0.0.0.0",
      port: 19090,
    })
    expect(saveFileReceiverConfig).toHaveBeenCalledWith({
      enabled: false,
      autoStart: false,
      staticToken: "team-secret",
      maxFileSizeBytes: 1024 * 1024 * 1024,
      uploadTtlHours: 168,
    })
  })

  it("tests configured LLM, search, and embedding connections from the current form values", async () => {
    useWikiStore.setState({
      llmConfig: {
        provider: "openai",
        apiKey: "",
        model: "",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "",
        maxContextSize: 204800,
      },
      searchApiConfig: {
        provider: "tavily",
        apiKey: "",
      },
      embeddingConfig: {
        enabled: true,
        endpoint: "",
        apiKey: "",
        model: "",
      },
    })

    const user = userEvent.setup()
    render(<SettingsView />)

    await user.type(screen.getByPlaceholderText(/Enter your OpenAI API key/i), "sk-test")
    await user.type(screen.getByPlaceholderText(/or type a custom model name/i), "gpt-4o-mini")
    await user.type(screen.getByPlaceholderText(/Enter your Tavily API key/i), "tvly-test")
    await user.type(screen.getByPlaceholderText(/127\.0\.0\.1:1234/i), "http://127.0.0.1:1234/v1/embeddings")
    await user.type(screen.getByPlaceholderText(/Leave empty for local models/i), "embed-test")
    await user.type(screen.getByPlaceholderText(/text-embedding-qwen3/i), "text-embedding-test")

    await user.click(screen.getByRole("button", { name: /test llm connection/i }))
    await user.click(screen.getByRole("button", { name: /test search connection/i }))
    await user.click(screen.getByRole("button", { name: /test embedding connection/i }))

    await waitFor(() =>
      expect(testLlmConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          apiKey: "sk-test",
          model: "gpt-4o-mini",
        })
      )
    )
    expect(testSearchConnection).toHaveBeenCalledWith({
      provider: "tavily",
      apiKey: "tvly-test",
    })
    expect(testEmbeddingConnection).toHaveBeenCalledWith({
      enabled: true,
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      apiKey: "embed-test",
      model: "text-embedding-test",
    })
    expect(screen.getByText(/Connected: OpenAI \(gpt-4o-mini\)/i)).toBeInTheDocument()
    expect(screen.getByText(/Connected: Tavily/i)).toBeInTheDocument()
    expect(screen.getByText(/Connected: text-embedding-test \(3 dimensions\)/i)).toBeInTheDocument()
  })
})
