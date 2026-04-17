import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"

import {
  buildWikiContext,
  isWikiProject,
  listWikiProjects,
  readWikiPage,
  searchWiki,
  searchWikiFiles,
  tokenizeQuery,
} from "@/lib/wiki-query"

const tempRoots: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-mcp-test-"))
  tempRoots.push(dir)
  return dir
}

async function writeText(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, contents, "utf8")
}

async function createWikiProject(root: string): Promise<void> {
  await writeText(path.join(root, "schema.md"), "# Schema\nRules")
  await writeText(path.join(root, "purpose.md"), "# Purpose\nAnswer from the wiki")
  await writeText(path.join(root, "wiki/index.md"), "# Index\n- [[alpha]]\n- [[beta]]")
  await writeText(
    path.join(root, "wiki/entities/alpha.md"),
    [
      "---",
      'title: "Alpha Entity"',
      "---",
      "# Alpha Entity",
      "Alpha explains semantic retrieval for external agents and links to [[beta]].",
    ].join("\n"),
  )
  await writeText(
    path.join(root, "wiki/concepts/beta.md"),
    [
      "# Beta Concept",
      "This page describes Codex access, Claude usage, and knowledge search.",
    ].join("\n"),
  )
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("tokenizeQuery", () => {
  it("keeps meaningful English tokens and expands CJK bigrams", () => {
    const tokens = tokenizeQuery("什么是知识库 search")
    expect(tokens).toContain("知识库")
    expect(tokens).toContain("知识")
    expect(tokens).toContain("识库")
    expect(tokens).toContain("search")
    expect(tokens).not.toContain("什么")
  })
})

describe("wiki project discovery", () => {
  it("detects a valid wiki project by schema and wiki index", async () => {
    const projectRoot = await makeTempDir()
    await createWikiProject(projectRoot)

    await expect(isWikiProject(projectRoot)).resolves.toBe(true)
  })

  it("lists nested wiki projects under a workspace root", async () => {
    const workspaceRoot = await makeTempDir()
    const projectA = path.join(workspaceRoot, "project-a")
    const projectB = path.join(workspaceRoot, "group/project-b")
    await createWikiProject(projectA)
    await createWikiProject(projectB)
    await mkdir(path.join(workspaceRoot, "notes"), { recursive: true })

    const projects = await listWikiProjects(workspaceRoot)

    expect(projects.map((project) => project.path)).toEqual([projectA, projectB])
  })
})

describe("wiki search and read", () => {
  it("ranks title matches above content-only matches", async () => {
    const projectRoot = await makeTempDir()
    await createWikiProject(projectRoot)
    await writeText(
      path.join(projectRoot, "wiki/synthesis/gamma.md"),
      "# Gamma\nThis page mentions alpha in the body only.",
    )

    const results = await searchWikiFiles(projectRoot, "alpha")

    expect(results[0]).toMatchObject({
      title: "Alpha Entity",
      titleMatch: true,
    })
    expect(results.some((result) => result.title === "Gamma")).toBe(true)
  })

  it("reads a page by wiki-relative path and returns parsed metadata", async () => {
    const projectRoot = await makeTempDir()
    await createWikiProject(projectRoot)

    const page = await readWikiPage(projectRoot, "entities/alpha.md")

    expect(page).toMatchObject({
      title: "Alpha Entity",
      exists: true,
      relativePath: "entities/alpha.md",
    })
    expect(page.content).toContain("semantic retrieval")
  })

  it("supports semantic mode through vector search results", async () => {
    const projectRoot = await makeTempDir()
    await createWikiProject(projectRoot)

    const results = await searchWiki(projectRoot, "assistant access", {
      mode: "semantic",
      limit: 5,
      vectorSearch: async () => [
        { id: "beta", score: 0.92 },
      ],
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      title: "Beta Concept",
      relativePath: "concepts/beta.md",
      titleMatch: false,
    })
  })

  it("supports hybrid mode by merging semantic-only results with keyword matches", async () => {
    const projectRoot = await makeTempDir()
    await createWikiProject(projectRoot)

    const results = await searchWiki(projectRoot, "alpha", {
      mode: "hybrid",
      limit: 5,
      vectorSearch: async () => [
        { id: "beta", score: 0.88 },
      ],
    })

    expect(results[0]?.title).toBe("Alpha Entity")
    expect(results.some((result) => result.title === "Beta Concept")).toBe(true)
  })
})

describe("buildWikiContext", () => {
  it("returns purpose, schema, index, and top matching pages for a query", async () => {
    const projectRoot = await makeTempDir()
    await createWikiProject(projectRoot)

    const context = await buildWikiContext(projectRoot, "external agents alpha", 2)

    expect(context.projectPath).toBe(projectRoot)
    expect(context.purpose).toContain("Answer from the wiki")
    expect(context.schema).toContain("Rules")
    expect(context.index).toContain("[[alpha]]")
    expect(context.pages.length).toBeGreaterThanOrEqual(2)
    expect(context.pages[0]?.title).toBe("Alpha Entity")
    expect(context.pages.some((page) => page.title === "Beta Concept")).toBe(true)
  })

  it("uses hybrid mode when requested and includes semantically retrieved pages", async () => {
    const projectRoot = await makeTempDir()
    await createWikiProject(projectRoot)

    const context = await buildWikiContext(projectRoot, "knowledge retrieval", 3, {
      mode: "hybrid",
      vectorSearch: async () => [{ id: "beta", score: 0.91 }],
    })

    expect(context.pages.some((page) => page.title === "Beta Concept")).toBe(true)
  })

  it("includes graph-expanded wiki pages in the context bundle", async () => {
    const projectRoot = await makeTempDir()
    await createWikiProject(projectRoot)

    const context = await buildWikiContext(projectRoot, "alpha retrieval", 3)

    expect(context.pages.map((page) => page.title)).toContain("Beta Concept")
  })
})
