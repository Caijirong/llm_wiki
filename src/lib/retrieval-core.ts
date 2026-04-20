import { getFileName, getRelativePath } from "./path-utils.js"
import {
  buildSnippet,
  extractTitle,
  tokenMatchScore,
  tokenizeQuery,
} from "./retrieval-text.js"

export interface RetrievalSearchResult {
  path: string
  title: string
  snippet: string
  titleMatch: boolean
  score: number
}

export interface RetrievalGraphExpansion {
  title: string
  path: string
  relevance: number
}

export interface RetrievalContextPage {
  title: string
  path: string
  content: string
  priority: number
}

export interface RetrievalReference {
  title: string
  path: string
}

export interface RetrievalContextBundle {
  purpose: string
  index: string
  pageList: string
  pages: RetrievalContextPage[]
  references: RetrievalReference[]
}

interface BuildRetrievalContextInput {
  projectPath: string
  query: string
  maxContextSize: number
  index: string
  purpose: string
  searchResults: RetrievalSearchResult[]
  graphExpansions: RetrievalGraphExpansion[]
  overviewPath: string
  readText: (path: string) => Promise<string>
}

export async function buildRetrievalContextBundle(
  input: BuildRetrievalContextInput,
): Promise<RetrievalContextBundle> {
  const maxCtx = input.maxContextSize || 204800
  const indexBudget = Math.floor(maxCtx * 0.05)
  const pageBudget = Math.floor(maxCtx * 0.6)
  const maxPageSize = Math.min(Math.floor(pageBudget * 0.3), 30_000)

  const trimmedIndex = trimIndex(input.index, input.query, indexBudget)
  const relevantPages: RetrievalContextPage[] = []
  const seenPaths = new Set<string>()
  let usedChars = 0

  const tryAddPage = async (title: string, filePath: string, priority: number): Promise<boolean> => {
    if (usedChars >= pageBudget || seenPaths.has(filePath)) return false

    try {
      const raw = await input.readText(filePath)
      if (!raw) return false

      const relativePath = getRelativePath(filePath, input.projectPath)
      const truncated = raw.length > maxPageSize
        ? `${raw.slice(0, maxPageSize)}\n\n[...truncated...]`
        : raw

      if (usedChars + truncated.length > pageBudget) return false

      usedChars += truncated.length
      seenPaths.add(filePath)
      relevantPages.push({
        title,
        path: relativePath,
        content: truncated,
        priority,
      })
      return true
    } catch {
      return false
    }
  }

  for (const result of input.searchResults.filter((result) => result.titleMatch)) {
    await tryAddPage(result.title, result.path, 0)
  }

  for (const result of input.searchResults.filter((result) => !result.titleMatch)) {
    await tryAddPage(result.title, result.path, 1)
  }

  for (const expansion of input.graphExpansions) {
    await tryAddPage(expansion.title, expansion.path, 2)
  }

  if (relevantPages.length === 0) {
    await tryAddPage("Overview", input.overviewPath, 3)
  }

  const pageList = relevantPages.map((page, index) =>
    `[${index + 1}] ${page.title} (${page.path})`,
  ).join("\n")

  return {
    purpose: input.purpose,
    index: trimmedIndex,
    pageList,
    pages: relevantPages,
    references: relevantPages.map((page) => ({
      title: page.title,
      path: page.path,
    })),
  }
}

export function makeSearchResultFromContent(
  path: string,
  fileName: string,
  content: string,
  tokens: readonly string[],
  query: string,
  titleMatchBonus: number,
): RetrievalSearchResult | null {
  const title = extractTitle(content, fileName)
  const titleText = `${title} ${fileName}`
  const titleScore = scoreText(titleText, tokens)
  const contentScore = scoreText(content, tokens)

  if (titleScore === 0 && contentScore === 0) return null

  const titleMatch = titleScore > 0
  const firstMatchingToken = tokens.find((token) =>
    content.toLowerCase().includes(token),
  ) ?? query

  return {
    path,
    title,
    snippet: buildSnippet(content, firstMatchingToken),
    titleMatch,
    score: contentScore + (titleMatch ? titleMatchBonus : 0),
  }
}

function scoreText(text: string, tokens: readonly string[]): number {
  return tokenMatchScore(text, tokens)
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

  const trimmed = keptLines.join("\n")
  return trimmed.length < index.length
    ? `${trimmed}\n\n[...index trimmed to relevant entries...]`
    : trimmed
}

export function resolvePageTitle(content: string, filePath: string): string {
  return extractTitle(content, getFileName(filePath))
}

const TITLE_MATCH_BONUS_FALLBACK = 10

export function getEffectiveTokens(query: string): string[] {
  const tokens = tokenizeQuery(query)
  return tokens.length > 0 ? tokens : [query.trim().toLowerCase()]
}

export function scoreSearchContent(
  path: string,
  content: string,
  query: string,
  titleMatchBonus: number = TITLE_MATCH_BONUS_FALLBACK,
): RetrievalSearchResult | null {
  return makeSearchResultFromContent(
    path,
    getFileName(path),
    content,
    getEffectiveTokens(query),
    query,
    titleMatchBonus,
  )
}
