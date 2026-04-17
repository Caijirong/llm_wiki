import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import {
  type RetrievalSearchResult,
  getEffectiveTokens,
  makeSearchResultFromContent,
} from "@/lib/retrieval-core"
export { tokenizeQuery } from "@/lib/retrieval-text"

export type SearchResult = RetrievalSearchResult

const MAX_RESULTS = 20
const TITLE_MATCH_BONUS = 10

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

export async function searchWiki(
  projectPath: string,
  query: string,
): Promise<SearchResult[]> {
  if (!query.trim()) return []
  const pp = normalizePath(projectPath)

  const effectiveTokens = getEffectiveTokens(query)
  const results: SearchResult[] = []

  // Search wiki pages
  try {
    const wikiTree = await listDirectory(`${pp}/wiki`)
    const wikiFiles = flattenMdFiles(wikiTree)
    await searchFiles(wikiFiles, effectiveTokens, query, results)
  } catch {
    // no wiki directory
  }

  // Also search raw sources (extracted text)
  try {
    const rawTree = await listDirectory(`${pp}/raw/sources`)
    const rawFiles = flattenAllFiles(rawTree)
    await searchFiles(rawFiles, effectiveTokens, query, results)
  } catch {
    // no raw sources
  }

  // Vector search: merge semantic results if embedding enabled
  try {
    const { useWikiStore } = await import("@/stores/wiki-store")
    const embCfg = useWikiStore.getState().embeddingConfig
    console.log(`[Vector Search] Config: enabled=${embCfg.enabled}, model="${embCfg.model}"`)
    if (embCfg.enabled && embCfg.model) {
      const t0 = performance.now()
      const { searchByEmbedding } = await import("@/lib/embedding")
      const vectorResults = await searchByEmbedding(pp, query, embCfg, 10)
      const vectorMs = Math.round(performance.now() - t0)

      console.log(
        `[Vector Search] query="${query}" | ${vectorResults.length} results in ${vectorMs}ms | model=${embCfg.model}` +
        (vectorResults.length > 0
          ? ` | top: ${vectorResults.slice(0, 5).map((r) => `${r.id}(${r.score.toFixed(3)})`).join(", ")}`
          : "")
      )

      let boosted = 0
      let added = 0
      const existingPaths = new Set(results.map((r) => r.path))

      for (const vr of vectorResults) {
        // Check if already in results
        const existing = results.find((r) => {
          const fileName = r.path.split("/").pop()?.replace(/\.md$/, "") ?? ""
          return fileName === vr.id
        })

        if (existing) {
          // Boost score of existing result
          existing.score += vr.score * 5
          boosted++
        } else {
          // Try to find the file and add it
          const dirs = ["entities", "concepts", "sources", "synthesis", "comparison", "queries"]
          for (const dir of dirs) {
            const tryPath = `${pp}/wiki/${dir}/${vr.id}.md`
            if (existingPaths.has(tryPath)) break
            try {
              const content = await readFile(tryPath)
              const built = makeSearchResultFromContent(
                tryPath,
                `${vr.id}.md`,
                content,
                effectiveTokens,
                query,
                TITLE_MATCH_BONUS,
              )
              if (!built) break
              results.push({ ...built, titleMatch: false, score: vr.score * 5 })
              existingPaths.add(tryPath)
              added++
              break
            } catch {
              // not in this directory
            }
          }
        }
      }

      if (boosted > 0 || added > 0) {
        console.log(`[Vector Search] Merged: ${boosted} boosted, ${added} new pages added`)
      }
    }
  } catch (err) {
    console.log(`[Vector Search] Skipped: ${err instanceof Error ? err.message : "not available"}`)
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score)

  const tokenCount = results.filter((r) => r.score > 0).length
  console.log(`[Search] query="${query}" | ${tokenCount} token matches | ${results.length} total results`)

  return results.slice(0, MAX_RESULTS)
}

async function searchFiles(
  files: FileNode[],
  tokens: readonly string[],
  query: string,
  results: SearchResult[],
): Promise<void> {
  for (const file of files) {
    let content = ""
    try {
      content = await readFile(file.path)
    } catch {
      continue
    }
    const built = makeSearchResultFromContent(
      file.path,
      file.name,
      content,
      tokens,
      query,
      TITLE_MATCH_BONUS,
    )
    if (built) results.push(built)
  }
}

function flattenAllFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenAllFiles(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}
