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

import { loadMcpConfig, saveMcpConfig } from "@/lib/project-store"

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
})
