import path from "node:path"
import { readdir, readFile, stat } from "node:fs/promises"

export interface WikiProjectInfo {
  name: string
  path: string
}

export interface WikiSearchResult {
  path: string
  relativePath: string
  title: string
  snippet: string
  titleMatch: boolean
  score: number
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
const SNIPPET_CONTEXT = 80
const TITLE_MATCH_BONUS = 10
const DEFAULT_DISCOVERY_DEPTH = 5
const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
])

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".vscode",
  "dist",
  "node_modules",
  "src-tauri/target",
  "target",
])

export function tokenizeQuery(query: string): string[] {
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .filter((token) => token.length > 1)
    .filter((token) => !STOP_WORDS.has(token))

  const tokens: string[] = []

  for (const token of rawTokens) {
    const hasCjk = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)

    if (hasCjk && token.length > 2) {
      const chars = [...token]
      for (let window = 2; window <= Math.min(chars.length, 4); window += 1) {
        for (let i = 0; i <= chars.length - window; i += 1) {
          const ngram = chars.slice(i, i + window).join("")
          if (!STOP_WORDS.has(ngram)) {
            tokens.push(ngram)
          }
        }
      }
      for (const ch of chars) {
        if (!STOP_WORDS.has(ch)) {
          tokens.push(ch)
        }
      }
      continue
    }

    tokens.push(token)
  }

  return [...new Set(tokens)]
}

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
  const tokens = tokenizeQuery(query)
  const effectiveTokens = tokens.length > 0 ? tokens : [query.trim().toLowerCase()]
  const results: WikiSearchResult[] = []

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8")
    const title = extractTitle(content, path.basename(filePath))
    const titleScore = tokenMatchScore(`${title} ${path.basename(filePath)}`, effectiveTokens)
    const contentScore = tokenMatchScore(content, effectiveTokens)

    if (titleScore === 0 && contentScore === 0) continue

    const firstMatchingToken = effectiveTokens.find((token) =>
      content.toLowerCase().includes(token),
    ) ?? query

    results.push({
      path: filePath,
      relativePath: path.relative(wikiRoot, filePath),
      title,
      snippet: buildSnippet(content, firstMatchingToken),
      titleMatch: titleScore > 0,
      score: contentScore + (titleScore > 0 ? TITLE_MATCH_BONUS : 0),
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

  const pages = await Promise.all(
    results.map((result) => readWikiPage(projectPath, result.relativePath)),
  )

  return {
    projectPath,
    purpose,
    schema,
    index,
    pages: pages.filter((page) => page.exists),
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

function buildSnippet(content: string, query: string): string {
  const lower = content.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const index = lower.indexOf(lowerQuery)

  if (index === -1) {
    return content.slice(0, SNIPPET_CONTEXT * 2).replace(/\n/g, " ")
  }

  const start = Math.max(0, index - SNIPPET_CONTEXT)
  const end = Math.min(content.length, index + query.length + SNIPPET_CONTEXT)
  let snippet = content.slice(start, end).replace(/\n/g, " ")
  if (start > 0) snippet = `...${snippet}`
  if (end < content.length) snippet = `${snippet}...`
  return snippet
}

function extractTitle(content: string, fileName: string): string {
  const frontmatterMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
  if (frontmatterMatch) return frontmatterMatch[1].trim()

  const headingMatch = content.match(/^#\s+(.+)$/m)
  if (headingMatch) return headingMatch[1].trim()

  return fileName.replace(/\.md$/, "").replace(/-/g, " ")
}

function normalizeRelativePagePath(pagePathOrId: string): string {
  return pagePathOrId.replace(/^wiki\//, "").replace(/\\/g, "/")
}

function tokenMatchScore(text: string, tokens: readonly string[]): number {
  const lower = text.toLowerCase()
  let score = 0

  for (const token of tokens) {
    if (lower.includes(token)) {
      score += 1
    }
  }

  return score
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
  const files: string[] = []

  async function walk(currentPath: string): Promise<void> {
    let entries
    try {
      entries = await readdir(currentPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
        continue
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(entryPath)
      }
    }
  }

  await walk(rootPath)
  return files
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
