import path from "node:path"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { describe, expect, it } from "vitest"

import { resolveProjectDiscoveryRoot } from "@/mcp/project-discovery"

async function makeWikiProject(root: string, name: string): Promise<string> {
  const projectRoot = path.join(root, name)
  await mkdir(path.join(projectRoot, "wiki"), { recursive: true })
  await writeFile(path.join(projectRoot, "schema.md"), "# schema\n", "utf8")
  await writeFile(path.join(projectRoot, "wiki", "index.md"), "# index\n", "utf8")
  return projectRoot
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "llm-wiki-mcp-discovery-"))
}

describe("resolveProjectDiscoveryRoot", () => {
  it("uses the explicit root when it already contains wiki projects", async () => {
    const workspaceRoot = await makeTempDir()
    const explicitRoot = await makeTempDir()
    const projectRoot = await makeWikiProject(explicitRoot, "alpha")

    const resolved = await resolveProjectDiscoveryRoot(explicitRoot, workspaceRoot)

    expect(resolved.workspaceRoot).toBe(explicitRoot)
    expect(resolved.fallbackUsed).toBe(false)
    expect(resolved.projects).toEqual([
      { name: "alpha", path: projectRoot },
    ])
  })

  it("falls back to the default root when the explicit root has no wiki projects", async () => {
    const workspaceRoot = await makeTempDir()
    const explicitRoot = await makeTempDir()
    const projectRoot = await makeWikiProject(workspaceRoot, "beta")

    const resolved = await resolveProjectDiscoveryRoot(explicitRoot, workspaceRoot)

    expect(resolved.workspaceRoot).toBe(workspaceRoot)
    expect(resolved.fallbackUsed).toBe(true)
    expect(resolved.projects).toEqual([
      { name: "beta", path: projectRoot },
    ])
  })
})
