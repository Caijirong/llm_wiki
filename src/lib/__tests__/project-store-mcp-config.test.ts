import { beforeEach, describe, expect, it, vi } from "vitest"

const memoryStore = new Map<string, unknown>()

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async <T>(key: string) => memoryStore.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      memoryStore.set(key, value)
    },
  })),
}))

import {
  loadFileReceiverConfig,
  loadMcpConfig,
  saveFileReceiverConfig,
  saveMcpConfig,
} from "@/lib/project-store"

describe("project-store mcp config", () => {
  beforeEach(() => {
    memoryStore.clear()
  })

  it("returns null when mcp config is not persisted", async () => {
    await expect(loadMcpConfig()).resolves.toBeNull()
  })

  it("saves and loads mcp config", async () => {
    const config = { autoStart: true, enabled: true, host: "127.0.0.1", port: 18765 }
    await saveMcpConfig(config)
    await expect(loadMcpConfig()).resolves.toEqual(config)
  })

  it("returns null when file receiver config is not persisted", async () => {
    await expect(loadFileReceiverConfig()).resolves.toBeNull()
  })

  it("saves and loads file receiver config", async () => {
    const config = {
      autoStart: true,
      enabled: true,
      host: "0.0.0.0",
      port: 18766,
      staticToken: "secret",
      maxFileSizeBytes: 1024 * 1024 * 512,
      uploadTtlHours: 72,
    }
    await saveFileReceiverConfig(config)
    await expect(loadFileReceiverConfig()).resolves.toEqual(config)
  })
})
