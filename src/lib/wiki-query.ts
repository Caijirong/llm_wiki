import path from "node:path"
import { readdir, readFile, stat } from "node:fs/promises"
import type { FileNode } from "../types/wiki.js"
import {
  buildRetrievalContextBundle,
  getEffectiveTokens,
  makeSearchResultFromContent,
  type RetrievalSearchResult,
} from "./retrieval-core.js"
import { buildSnippet, extractTitle } from "./retrieval-text.js"
import {
  buildRetrievalGraphWithAdapter,
  getRelatedNodes,
} from "./retrieval-graph-core.js"

export interface WikiProjectInfo {
  name: string
  path: string
}

export interface WikiSearchResult extends RetrievalSearchResult {
  relativePath: string
}

export interface VectorSearchResult {
  id: string
  score: number
}

export type SearchMode = "keyword" | "semantic" | "hybrid"

export interface SearchWikiOptions {
  mode?: SearchMode
  limit?: number
  vectorSearch?: (query: string, limit: number) => Promise<VectorSearchResult[]>
}

export interface WikiPage {
  exists: boolean
  path: string
  relativePath: string
  title: string
  content: string
}

export interface WikiContextBundle {
  projectPath: string
  purpose: string
  schema: string
  index: string
  pages: WikiPage[]
}

const MAX_RESULTS = 20
const TITLE_MATCH_BONUS = 10
const DEFAULT_DISCOVERY_DEPTH = 5

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".vscode",
  "dist",
  "node_modules",
  "src-tauri/target",
  "target",
])

export { tokenizeQuery } from "./retrieval-text.js"

export async function isWikiProject(projectPath: string): Promise<boolean> {
  const requiredPaths = [
    path.join(projectPath, "schema.md"),
    path.join(projectPath, "wiki"),
    path.join(projectPath, "wiki/index.md"),
  ]

  const checks = await Promise.all(requiredPaths.map(async (requiredPath) => pathExists(requiredPath)))
  return checks.every(Boolean)
}

export async function listWikiProjects(rootPath: string, maxDepth: number = DEFAULT_DISCOVERY_DEPTH): Promise<WikiProjectInfo[]> {
  const projects: WikiProjectInfo[] = []

  async function walk(currentPath: string, depth: number): Promise<void> {
    if (depth > maxDepth) return

    if (await isWikiProject(currentPath)) {
      projects.push({
        name: path.basename(currentPath),
        path: currentPath,
      })
      return
    }

    let entries
    try {
      entries = await readdir(currentPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      await walk(path.join(currentPath, entry.name), depth + 1)
    }
  }

  await walk(rootPath, 0)

  return projects.sort((a, b) => {
    const depthDiff = depthOfPath(a.path) - depthOfPath(b.path)
    return depthDiff !== 0 ? depthDiff : a.path.localeCompare(b.path)
  })
}

export async function searchWikiFiles(
  projectPath: string,
  query: string,
  limit: number = MAX_RESULTS,
): Promise<WikiSearchResult[]> {
  if (!query.trim()) return []

  const wikiRoot = path.join(projectPath, "wiki")
  const files = await getMarkdownFiles(wikiRoot)
  const effectiveTokens = getEffectiveTokens(query)
  const results: WikiSearchResult[] = []

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8")
    const built = makeSearchResultFromContent(
      filePath,
      path.basename(filePath),
      content,
      effectiveTokens,
      query,
      TITLE_MATCH_BONUS,
    )
    if (!built) continue

    results.push({
      ...built,
      relativePath: path.relative(wikiRoot, filePath),
    })
  }

  return results
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
    .slice(0, limit)
}

export async function searchWiki(
  projectPath: string,
  query: string,
  options: SearchWikiOptions = {},
): Promise<WikiSearchResult[]> {
  const mode = options.mode ?? "keyword"
  const limit = options.limit ?? MAX_RESULTS

  if (mode === "keyword") {
    return searchWikiFiles(projectPath, query, limit)
  }

  const [keywordResults, vectorResults] = await Promise.all([
    mode === "hybrid" ? searchWikiFiles(projectPath, query, limit) : Promise.resolve<WikiSearchResult[]>([]),
    options.vectorSearch ? options.vectorSearch(query, limit) : Promise.resolve<VectorSearchResult[]>([]),
  ])

  return mergeSearchResults(projectPath, keywordResults, vectorResults, limit)
}

export async function readWikiPage(projectPath: string, pagePathOrId: string): Promise<WikiPage> {
  const wikiRoot = path.join(projectPath, "wiki")
  const resolvedPath = await resolvePagePath(wikiRoot, pagePathOrId)

  if (!resolvedPath) {
    return {
      exists: false,
      path: "",
      relativePath: normalizeRelativePagePath(pagePathOrId),
      title: pagePathOrId,
      content: "",
    }
  }

  const content = await readFile(resolvedPath, "utf8")
  return {
    exists: true,
    path: resolvedPath,
    relativePath: path.relative(wikiRoot, resolvedPath),
    title: extractTitle(content, path.basename(resolvedPath)),
    content,
  }
}

export async function buildWikiContext(
  projectPath: string,
  query: string,
  maxPages: number = 5,
  searchOptions: SearchWikiOptions = {},
): Promise<WikiContextBundle> {
  const [purpose, schema, index, results] = await Promise.all([
    readTextIfExists(path.join(projectPath, "purpose.md")),
    readTextIfExists(path.join(projectPath, "schema.md")),
    readTextIfExists(path.join(projectPath, "wiki/index.md")),
    searchWiki(projectPath, query, {
      ...searchOptions,
      limit: maxPages,
    }),
  ])

  const graph = await buildRetrievalGraphWithAdapter(
    path.join(projectPath, "wiki"),
    {
      listDirectory: async (dirPath) => listFileTree(dirPath),
      readText: async (filePath) => readTextIfExists(filePath),
    },
  )

  const expandedIds = new Set<string>()
  const searchHitPaths = new Set(results.map((result) => result.path))
  const graphExpansions: Array<{ title: string; path: string; relevance: number }> = []

  for (const result of results) {
    const nodeId = path.basename(result.path).replace(/\.md$/, "")
    const related = getRelatedNodes(nodeId, graph, 3)
    for (const { node, relevance } of related) {
      if (relevance < 2.0) continue
      if (searchHitPaths.has(node.path)) continue
      if (expandedIds.has(node.id)) continue
      expandedIds.add(node.id)
      graphExpansions.push({
        title: node.title,
        path: node.path,
        relevance,
      })
    }
  }

  graphExpansions.sort((a, b) => b.relevance - a.relevance)

  const bundle = await buildRetrievalContextBundle({
    projectPath,
    query,
    maxContextSize: 204800,
    index,
    purpose,
    searchResults: results,
    graphExpansions,
    overviewPath: path.join(projectPath, "wiki", "overview.md"),
    readText: async (filePath) => readTextIfExists(filePath),
  })

  return {
    projectPath,
    purpose: bundle.purpose,
    schema,
    index: bundle.index,
    pages: bundle.pages.map((page) => ({
      exists: true,
      path: path.join(projectPath, page.path),
      relativePath: page.path.replace(/^wiki\//, ""),
      title: page.title,
      content: page.content,
    })),
  }
}

async function mergeSearchResults(
  projectPath: string,
  keywordResults: WikiSearchResult[],
  vectorResults: VectorSearchResult[],
  limit: number,
): Promise<WikiSearchResult[]> {
  const merged = new Map<string, WikiSearchResult>()

  for (const result of keywordResults) {
    merged.set(result.relativePath, result)
  }

  for (const vectorResult of vectorResults) {
    const vectorPage = await resolveVectorResult(projectPath, vectorResult)
    if (!vectorPage) continue

    const existing = merged.get(vectorPage.relativePath)
    const vectorScore = vectorResult.score * 5

    if (existing) {
      existing.score += vectorScore
      continue
    }

    merged.set(vectorPage.relativePath, {
      path: vectorPage.path,
      relativePath: vectorPage.relativePath,
      title: vectorPage.title,
      snippet: buildSnippet(vectorPage.content, vectorPage.title),
      titleMatch: false,
      score: vectorScore,
    })
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
    .slice(0, limit)
}

function normalizeRelativePagePath(pagePathOrId: string): string {
  return pagePathOrId.replace(/^wiki\//, "").replace(/\\/g, "/")
}

async function resolvePagePath(wikiRoot: string, pagePathOrId: string): Promise<string | null> {
  const normalized = normalizeRelativePagePath(pagePathOrId)
  const directCandidates = [
    path.join(wikiRoot, normalized),
    path.join(wikiRoot, normalized.endsWith(".md") ? normalized : `${normalized}.md`),
  ]

  for (const candidate of directCandidates) {
    if (await pathExists(candidate)) {
      return candidate
    }
  }

  const baseName = path.basename(normalized).replace(/\.md$/, "")
  const files = await getMarkdownFiles(wikiRoot)
  return files.find((filePath) => path.basename(filePath, ".md") === baseName) ?? null
}

async function resolveVectorResult(
  projectPath: string,
  vectorResult: VectorSearchResult,
): Promise<WikiPage | null> {
  const page = await readWikiPage(projectPath, vectorResult.id)
  return page.exists ? page : null
}

async function getMarkdownFiles(rootPath: string): Promise<string[]> {
  const tree = await listFileTree(rootPath)
  const files: string[] = []

  function walk(nodes: FileNode[]): void {
    for (const node of nodes) {
      if (node.is_dir && node.children) {
        walk(node.children)
      } else if (!node.is_dir && node.name.endsWith(".md")) {
        files.push(node.path)
      }
    }
  }

  walk(tree)
  return files
}

async function listFileTree(rootPath: string): Promise<FileNode[]> {
  let entries
  try {
    entries = await readdir(rootPath, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: FileNode[] = []
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name)
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: entryPath,
        is_dir: true,
        children: await listFileTree(entryPath),
      })
    } else {
      nodes.push({
        name: entry.name,
        path: entryPath,
        is_dir: false,
      })
    }
  }
  return nodes
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8")
  } catch {
    return ""
  }
}

function depthOfPath(targetPath: string): number {
  return targetPath.split(path.sep).filter(Boolean).length
}
