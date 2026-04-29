import type { FileReceiverConfig, McpConfig } from "@/stores/wiki-store"

const DEFAULT_FILE_RECEIVER_CONFIG: FileReceiverConfig = {
  enabled: false,
  autoStart: false,
  staticToken: "",
  maxFileSizeBytes: 1024 * 1024 * 1024,
  uploadTtlHours: 24 * 7,
}

export function createUploadToken(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto?.getRandomValues(bytes)
  if (bytes.some((byte) => byte !== 0)) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }

  return `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`
}

export function normalizeFileReceiverConfigForMcp(
  mcpConfig: McpConfig,
  config: FileReceiverConfig | null,
  generateToken: () => string = createUploadToken
): FileReceiverConfig {
  const base = config ?? DEFAULT_FILE_RECEIVER_CONFIG
  const staticToken = base.staticToken.trim()
  const generatedToken = mcpConfig.enabled && !staticToken ? generateToken().trim() : ""

  return {
    enabled: mcpConfig.enabled,
    autoStart: mcpConfig.autoStart,
    staticToken: staticToken || generatedToken,
    maxFileSizeBytes: base.maxFileSizeBytes,
    uploadTtlHours: base.uploadTtlHours,
  }
}
