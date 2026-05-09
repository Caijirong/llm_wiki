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

export interface ChatKnowledgeImage {
  url: string
  alt: string
  sourceTitle: string
  sourcePath: string
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
  knowledgeImages: ChatKnowledgeImage[]
  knowledgeImagesMarkdown: string
  knowledgeImagesPromptContext: string
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

  const allSearchResults = (await searchWiki(pp, options.query))
    .map((result) => ({
      ...result,
      relativePath: getRelativePath(result.path, `${pp}/wiki`),
    }))
  const imageSearchResults = prioritizeImageSearchResults(
    allSearchResults,
    options.query,
  )
  const searchResults = mergeSearchResults(
    allSearchResults.slice(0, searchLimit),
    imageSearchResults,
  )

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
  const pagePaths = new Set<string>()
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY

  const tryAddPage = async (
    title: string,
    filePath: string,
    priority: number,
  ): Promise<boolean> => {
    if (pages.length >= maxPages || usedChars >= pageBudget) return false
    const normalizedPath = normalizePath(filePath)
    if (pagePaths.has(normalizedPath)) return false
    try {
      const raw = await readFile(filePath)
      const relativePath = getRelativePath(filePath, pp)
      const truncated = raw.length > perPageLimit
        ? raw.slice(0, perPageLimit) + "\n\n[...truncated...]"
        : raw
      if (usedChars + truncated.length > pageBudget) return false
      usedChars += truncated.length
      pagePaths.add(normalizedPath)
      pages.push({ title, path: relativePath, content: truncated, priority })
      return true
    } catch {
      return false
    }
  }

  for (const result of imageSearchResults) {
    await tryAddPage(result.title, result.path, -1)
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
  const knowledgeImages = collectKnowledgeImages(searchResults, options.query)
  const knowledgeImagesMarkdown = formatKnowledgeImageMarkdown(knowledgeImages)
  const knowledgeImagesPromptContext = formatKnowledgeImagePromptContext(knowledgeImages)

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
    knowledgeImages,
    knowledgeImagesMarkdown,
    knowledgeImagesPromptContext,
    references: pages.map((page) => ({
      title: page.title,
      path: page.path,
    })),
  }
}

const TRIM_QUERY_PUNCT_RE =
  /^[\s,，。！？、；：""''（）()\-_/\\·~～…]+|[\s,，。！？、；：""''（）()\-_/\\·~～…]+$/g

function normalizeQueryPhrase(query: string): string {
  return query.trim().toLowerCase().replace(TRIM_QUERY_PUNCT_RE, "")
}

function imageQueryScore(imageAlt: string, query: string): number {
  const altLower = imageAlt.toLowerCase()
  const normalizedQuery = normalizeQueryPhrase(query)
  if (!altLower || !normalizedQuery) return 0

  let score = altLower.includes(normalizedQuery)
    ? 10_000 + normalizedQuery.length
    : 0

  for (const token of tokenizeQuery(query)) {
    if (!altLower.includes(token)) continue
    score += token.length > 1 ? token.length * 2 : 1
  }

  return score
}

function imageStronglyMatchesQuery(imageAlt: string, query: string): boolean {
  const normalizedAlt = imageAlt.toLowerCase()
  const normalizedQuery = normalizeQueryPhrase(query)
  if (!normalizedAlt || !normalizedQuery) return false
  if (normalizedAlt.includes(normalizedQuery)) return true
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return false
  const matched = tokens.filter((token) => normalizedAlt.includes(token)).length
  return matched >= Math.max(2, Math.ceil(tokens.length * 0.6))
}

function prioritizeImageSearchResults(
  results: ChatRetrievalSearchResult[],
  query: string,
): ChatRetrievalSearchResult[] {
  return results.filter((result) =>
    result.images.some((image) => imageStronglyMatchesQuery(image.alt, query)),
  )
}

function mergeSearchResults(
  primary: ChatRetrievalSearchResult[],
  additional: ChatRetrievalSearchResult[],
): ChatRetrievalSearchResult[] {
  const seen = new Set<string>()
  const merged: ChatRetrievalSearchResult[] = []
  for (const result of [...primary, ...additional]) {
    if (seen.has(result.path)) continue
    seen.add(result.path)
    merged.push(result)
  }
  return merged
}

function collectKnowledgeImages(
  searchResults: ChatRetrievalSearchResult[],
  query: string,
): ChatKnowledgeImage[] {
  const seen = new Set<string>()
  const matches: Array<{ image: ChatKnowledgeImage; score: number; order: number }> = []
  const supporting: ChatKnowledgeImage[] = []
  let order = 0

  for (const result of searchResults) {
    for (const image of result.images) {
      order += 1
      if (seen.has(image.url)) continue
      seen.add(image.url)
      const item = {
        url: image.url,
        alt: image.alt,
        sourceTitle: result.title,
        sourcePath: result.relativePath.startsWith("wiki/")
          ? result.relativePath
          : `wiki/${result.relativePath}`,
      }
      const score = imageQueryScore(image.alt, query)
      if (score > 0) {
        matches.push({ image: item, score, order })
      } else {
        supporting.push(item)
      }
    }
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.order - b.order
  })

  return [...matches.map((match) => match.image), ...supporting].slice(0, 5)
}

export function formatKnowledgeImageMarkdown(
  images: ChatKnowledgeImage[],
): string {
  if (images.length === 0) return ""
  return images
    .map((image, index) => {
      const alt = image.alt.trim() || `Image from ${image.sourceTitle}`
      const safeAlt = alt.replace(/[\r\n]+/g, " ").replace(/]/g, ")").trim()
      return [
        `### Image ${index + 1}: ${formatKnowledgeImageTitle(image, index)}`,
        `![${safeAlt}](${image.url})`,
        `Source: ${image.sourcePath}`,
      ].join("\n")
    })
    .join("\n\n")
}

export function formatKnowledgeImagePromptContext(
  images: ChatKnowledgeImage[],
): string {
  if (images.length === 0) return ""
  return images
    .map((image, index) => {
      const imageId = index + 1
      const alt = image.alt.trim() || `Image from ${image.sourceTitle}`
      return [
        `### Image ${imageId}: ${formatKnowledgeImageTitle(image, index)}`,
        `Use this image only by inserting [[image:${imageId}]] exactly once at the single most relevant point in your answer.`,
        `Description: ${alt.replace(/[\r\n]+/g, " ").trim()}`,
        `Source: ${image.sourcePath}`,
      ].join("\n")
    })
    .join("\n\n")
}

function formatKnowledgeImageTitle(
  image: ChatKnowledgeImage,
  index: number,
): string {
  const altTitle = extractImageTitleFromAlt(image.alt)
  if (altTitle) return altTitle
  return `Image ${index + 1} from ${image.sourceTitle}`
}

function extractImageTitleFromAlt(alt: string): string {
  const normalized = alt.replace(/[\r\n]+/g, " ").trim()
  if (!normalized) return ""
  const sentenceEnd = normalized.search(/[。！？]|(?<!\d)[.!?](?!\d)/)
  const title = sentenceEnd > 0
    ? normalized.slice(0, sentenceEnd)
    : normalized
  return title.slice(0, 80).trim()
}

export function appendKnowledgeImagesToAnswer(
  answer: string,
  imageMarkdown: string,
): string {
  const trimmedImages = imageMarkdown.trim()
  if (!trimmedImages) return answer
  if (answer.includes(trimmedImages)) return answer
  const trimmedAnswer = answer.trimEnd()
  return `${trimmedAnswer}\n\n## Related Images\n\n${trimmedImages}`
}

export function renderAnswerWithKnowledgeImages(
  answer: string,
  images: ChatKnowledgeImage[],
): string {
  if (images.length === 0) return answer

  const used = new Set<number>()
  let insertedCount = 0
  const rendered = answer.replace(/\[\[image:(\d+)\]\]/gi, (_full, rawIndex) => {
    const index = Number.parseInt(rawIndex, 10) - 1
    if (!Number.isInteger(index) || index < 0 || index >= images.length) return ""
    if (used.has(index)) return ""
    used.add(index)
    insertedCount += 1
    return renderInlineKnowledgeImage(images[index], index)
  })

  const trimmed = rendered.trimEnd()
  if (insertedCount > 0) return trimmed
  return appendKnowledgeImagesToAnswer(trimmed, formatKnowledgeImageMarkdown(images))
}

function renderInlineKnowledgeImage(
  image: ChatKnowledgeImage,
  index: number,
): string {
  const alt = image.alt.trim() || `Image from ${image.sourceTitle}`
  const safeAlt = alt.replace(/[\r\n]+/g, " ").replace(/]/g, ")").trim()
  const title = formatKnowledgeImageTitle(image, index).replace(/[\r\n]+/g, " ").trim()
  return [
    "",
    `![${safeAlt}](${image.url})`,
    `*${title}*`,
    "",
  ].join("\n")
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
