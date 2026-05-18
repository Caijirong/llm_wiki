import { beforeEach, describe, expect, it, vi } from "vitest"

const { files, storeEntries } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  storeEntries: new Map<string, unknown>(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    const content = files.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    files.set(path, content)
  }),
}))

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async <T>(key: string) => storeEntries.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      storeEntries.set(key, value)
    },
  })),
}))

import {
  ensureProjectId,
  getProjectKind,
  setProjectKind,
} from "./project-identity"

const PROJECT = "/wiki-project"
const IDENTITY_PATH = `${PROJECT}/.llm-wiki/project.json`

describe("project identity projectKind support", () => {
  beforeEach(() => {
    files.clear()
    storeEntries.clear()
  })

  it("treats legacy project.json without projectKind as general", async () => {
    files.set(
      IDENTITY_PATH,
      JSON.stringify({
        id: "project-123",
        createdAt: 1710000000000,
      }, null, 2),
    )

    await expect(ensureProjectId(PROJECT)).resolves.toBe("project-123")
    await expect(getProjectKind(PROJECT)).resolves.toBe("general")
  })

  it("writes projectKind without changing the existing id or createdAt", async () => {
    files.set(
      IDENTITY_PATH,
      JSON.stringify({
        id: "project-123",
        createdAt: 1710000000000,
      }, null, 2),
    )

    await setProjectKind(PROJECT, "document-manual")

    await expect(getProjectKind(PROJECT)).resolves.toBe("document-manual")
    expect(JSON.parse(files.get(IDENTITY_PATH) ?? "")).toEqual({
      id: "project-123",
      createdAt: 1710000000000,
      projectKind: "document-manual",
    })
  })
})
