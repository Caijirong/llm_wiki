import { readFile } from "@/commands/fs"
import { searchWiki, type SearchResult, tokenizeQuery } from "@/lib/search"
import { buildRetrievalGraph, getRelatedNodes } from "@/lib/graph-relevance"
import { computeContextBudget } from "@/lib/context-budget"
import { normalizePath, getFileName, getRelativePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"

export interface ChatRetrievalPage {
  title: string
  path: string
  content: string
  priority: number
}

export interface ChatRetrievalReference {
  title: string
  path: string
}

export interface ChatRetrievalSearchResult extends SearchResult {
  relativePath: string
}

export interface ChatRetrievalContext {
  projectPath: string
  query: string
  purpose: string
  schema: string
  index: string
  searchResults: ChatRetrievalSearchResult[]
  pages: ChatRetrievalPage[]
  pageList: string
  pagesContext: string
  references: ChatRetrievalReference[]
}

export interface BuildChatRetrievalContextOptions {
  projectPath: string
  query: string
  maxContextSize: number
  dataVersion?: number
  searchLimit?: number
  maxPages?: number
  pageCharLimit?: number
}

export async function buildChatRetrievalContext(
  options: BuildChatRetrievalContextOptions,
): Promise<ChatRetrievalContext> {
  const pp = normalizePath(options.projectPath)
  const searchLimit = options.searchLimit ?? 10
  const dataVersion = options.dataVersion ?? useWikiStore.getState().dataVersion
  const {
    indexBudget: indexBudget,
    pageBudget,
    maxPageSize,
  } = computeContextBudget(options.maxContextSize)
  const perPageLimit = options.pageCharLimit
    ? Math.min(maxPageSize, options.pageCharLimit)
    : maxPageSize

  const [rawIndex, purpose, schema] = await Promise.all([
    readFile(`${pp}/wiki/index.md`).catch(() => ""),
    readFile(`${pp}/purpose.md`).catch(() => ""),
    readFile(`${pp}/schema.md`).catch(() => ""),
  ])

  const searchResults = (await searchWiki(pp, options.query))
    .slice(0, searchLimit)
    .map((result) => ({
      ...result,
      relativePath: getRelativePath(result.path, `${pp}/wiki`),
    }))

  const index = trimIndex(rawIndex, options.query, indexBudget)
  const graph = await buildRetrievalGraph(pp, dataVersion)
  const expandedIds = new Set<string>()
  const searchHitPaths = new Set(searchResults.map((result) => result.path))
  const graphExpansions: Array<{ title: string; path: string; relevance: number }> = []

  for (const result of searchResults) {
    const fileName = getFileName(result.path)
    const nodeId = fileName.replace(/\.md$/, "")
    const related = getRelatedNodes(nodeId, graph, 3)
    for (const { node, relevance } of related) {
      if (relevance < 2.0) continue
      if (searchHitPaths.has(node.path)) continue
      if (expandedIds.has(node.id)) continue
      expandedIds.add(node.id)
      graphExpansions.push({ title: node.title, path: node.path, relevance })
    }
  }
  graphExpansions.sort((a, b) => b.relevance - a.relevance)

  let usedChars = 0
  const pages: ChatRetrievalPage[] = []
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY

  const tryAddPage = async (
    title: string,
    filePath: string,
    priority: number,
  ): Promise<boolean> => {
    if (pages.length >= maxPages || usedChars >= pageBudget) return false
    try {
      const raw = await readFile(filePath)
      const relativePath = getRelativePath(filePath, pp)
      const truncated = raw.length > perPageLimit
        ? raw.slice(0, perPageLimit) + "\n\n[...truncated...]"
        : raw
      if (usedChars + truncated.length > pageBudget) return false
      usedChars += truncated.length
      pages.push({ title, path: relativePath, content: truncated, priority })
      return true
    } catch {
      return false
    }
  }

  for (const result of searchResults.filter((result) => result.titleMatch)) {
    await tryAddPage(result.title, result.path, 0)
  }
  for (const result of searchResults.filter((result) => !result.titleMatch)) {
    await tryAddPage(result.title, result.path, 1)
  }
  for (const expansion of graphExpansions) {
    await tryAddPage(expansion.title, expansion.path, 2)
  }
  if (pages.length === 0) {
    await tryAddPage("Overview", `${pp}/wiki/overview.md`, 3)
  }

  const pageList = pages.map((page, index) =>
    `[${index + 1}] ${page.title} (${page.path})`,
  ).join("\n")
  const pagesContext = pages.length > 0
    ? pages.map((page, index) =>
        `### [${index + 1}] ${page.title}\nPath: ${page.path}\n\n${page.content}`
      ).join("\n\n---\n\n")
    : "(No wiki pages found)"

  return {
    projectPath: pp,
    query: options.query,
    purpose,
    schema,
    index,
    searchResults,
    pages,
    pageList,
    pagesContext,
    references: pages.map((page) => ({
      title: page.title,
      path: page.path,
    })),
  }
}

function trimIndex(index: string, query: string, budget: number): string {
  if (index.length <= budget) return index

  const tokens = tokenizeQuery(query)
  const lines = index.split("\n")
  const keptLines: string[] = []
  let keptSize = 0

  for (const line of lines) {
    const isHeader = line.startsWith("##")
    const lower = line.toLowerCase()
    const isRelevant = tokens.some((token) => lower.includes(token))

    if (isHeader || isRelevant) {
      if (keptSize + line.length + 1 <= budget) {
        keptLines.push(line)
        keptSize += line.length + 1
      }
    }
  }

  let trimmed = keptLines.join("\n")
  if (trimmed.length < index.length) {
    trimmed += "\n\n[...index trimmed to relevant entries...]"
  }
  return trimmed
}
