import { describe, expect, it } from "vitest"
import type { FileReceiverConfig, McpConfig } from "@/stores/wiki-store"
import { normalizeFileReceiverConfigForMcp } from "@/lib/runtime-service-config"

const mcpConfig: McpConfig = {
  enabled: true,
  autoStart: false,
  host: "127.0.0.1",
  port: 18765,
}

const fileReceiverConfig: FileReceiverConfig = {
  enabled: false,
  autoStart: true,
  staticToken: " team-secret ",
  maxFileSizeBytes: 1024 * 1024 * 1024,
  uploadTtlHours: 168,
}

describe("runtime service config", () => {
  it("makes upload availability follow the MCP service", () => {
    expect(
      normalizeFileReceiverConfigForMcp(mcpConfig, fileReceiverConfig, () => "generated-token")
    ).toEqual({
      enabled: true,
      autoStart: false,
      staticToken: "team-secret",
      maxFileSizeBytes: 1024 * 1024 * 1024,
      uploadTtlHours: 168,
    })
  })

  it("generates an upload token when MCP is enabled and no token exists", () => {
    const normalized = normalizeFileReceiverConfigForMcp(
      mcpConfig,
      { ...fileReceiverConfig, staticToken: "" },
      () => "generated-token"
    )

    expect(normalized.staticToken).toBe("generated-token")
  })

  it("does not generate a token when MCP is disabled", () => {
    const normalized = normalizeFileReceiverConfigForMcp(
      { ...mcpConfig, enabled: false },
      { ...fileReceiverConfig, staticToken: "" },
      () => "generated-token"
    )

    expect(normalized).toEqual({
      enabled: false,
      autoStart: false,
      staticToken: "",
      maxFileSizeBytes: 1024 * 1024 * 1024,
      uploadTtlHours: 168,
    })
  })
})
