import type { FileNode } from "../types/wiki.js"

export interface RetrievalNode {
  readonly id: string
  readonly title: string
  readonly type: string
  readonly path: string
  readonly sources: readonly string[]
  readonly outLinks: ReadonlySet<string>
  readonly inLinks: ReadonlySet<string>
}

export interface RetrievalGraph {
  readonly nodes: ReadonlyMap<string, RetrievalNode>
  readonly dataVersion: number
}

interface RetrievalGraphAdapter {
  listDirectory: (path: string) => Promise<FileNode[]>
  readText: (path: string) => Promise<string>
}

const WIKILINK_REGEX = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g

const WEIGHTS = {
  directLink: 3.0,
  sourceOverlap: 4.0,
  commonNeighbor: 1.5,
  typeAffinity: 1.0,
} as const

const TYPE_AFFINITY: Record<string, Record<string, number>> = {
  entity: { concept: 1.2, entity: 0.8, source: 1.0, synthesis: 1.0, query: 0.8 },
  concept: { entity: 1.2, concept: 0.8, source: 1.0, synthesis: 1.2, query: 1.0 },
  source: { entity: 1.0, concept: 1.0, source: 0.5, query: 0.8, synthesis: 1.0 },
  query: { concept: 1.0, entity: 0.8, synthesis: 1.0, source: 0.8, query: 0.5 },
  synthesis: { concept: 1.2, entity: 1.0, source: 1.0, query: 1.0, synthesis: 0.8 },
} as const

export async function buildRetrievalGraphWithAdapter(
  wikiRoot: string,
  adapter: RetrievalGraphAdapter,
  dataVersion: number = 0,
): Promise<RetrievalGraph> {
  let tree: FileNode[]
  try {
    tree = await adapter.listDirectory(wikiRoot)
  } catch {
    return { nodes: new Map(), dataVersion }
  }

  const mdFiles = flattenMdFiles(tree)
  const rawNodes: Array<{
    id: string
    title: string
    type: string
    path: string
    sources: string[]
    rawLinks: string[]
  }> = []

  for (const file of mdFiles) {
    const id = fileNameToId(file.name)
    let content = ""
    try {
      content = await adapter.readText(file.path)
    } catch {
      continue
    }

    const frontmatter = extractFrontmatter(content)
    rawNodes.push({
      id,
      title: frontmatter.title || file.name.replace(/\.md$/, "").replace(/-/g, " "),
      type: frontmatter.type,
      path: file.path,
      sources: frontmatter.sources,
      rawLinks: extractWikilinks(content),
    })
  }

  const nodeIds = new Set(rawNodes.map((node) => node.id))
  const outLinksMap = new Map<string, Set<string>>()
  const inLinksMap = new Map<string, Set<string>>()

  for (const id of nodeIds) {
    outLinksMap.set(id, new Set())
    inLinksMap.set(id, new Set())
  }

  for (const rawNode of rawNodes) {
    for (const target of rawNode.rawLinks) {
      const resolvedId = resolveTarget(target, nodeIds)
      if (!resolvedId || resolvedId === rawNode.id) continue
      outLinksMap.get(rawNode.id)?.add(resolvedId)
      inLinksMap.get(resolvedId)?.add(rawNode.id)
    }
  }

  const nodes = new Map<string, RetrievalNode>()
  for (const rawNode of rawNodes) {
    nodes.set(rawNode.id, {
      id: rawNode.id,
      title: rawNode.title,
      type: rawNode.type,
      path: rawNode.path,
      sources: Object.freeze([...rawNode.sources]),
      outLinks: Object.freeze(new Set<string>(outLinksMap.get(rawNode.id) ?? [])),
      inLinks: Object.freeze(new Set<string>(inLinksMap.get(rawNode.id) ?? [])),
    })
  }

  return { nodes, dataVersion }
}

export function calculateRelevance(
  nodeA: RetrievalNode,
  nodeB: RetrievalNode,
  graph: RetrievalGraph,
): number {
  if (nodeA.id === nodeB.id) return 0

  const forwardLinks = nodeA.outLinks.has(nodeB.id) ? 1 : 0
  const backwardLinks = nodeB.outLinks.has(nodeA.id) ? 1 : 0
  const directLinkScore = (forwardLinks + backwardLinks) * WEIGHTS.directLink

  const sourcesA = new Set(nodeA.sources)
  let sharedSourceCount = 0
  for (const source of nodeB.sources) {
    if (sourcesA.has(source)) sharedSourceCount += 1
  }
  const sourceOverlapScore = sharedSourceCount * WEIGHTS.sourceOverlap

  const neighborsA = getNeighbors(nodeA)
  const neighborsB = getNeighbors(nodeB)
  let adamicAdar = 0
  for (const neighborId of neighborsA) {
    if (neighborsB.has(neighborId)) {
      const neighbor = graph.nodes.get(neighborId)
      if (neighbor) {
        const degree = getNodeDegree(neighbor)
        adamicAdar += 1 / Math.log(Math.max(degree, 2))
      }
    }
  }
  const commonNeighborScore = adamicAdar * WEIGHTS.commonNeighbor

  const affinityMap = TYPE_AFFINITY[nodeA.type]
  const typeAffinityScore = (affinityMap?.[nodeB.type] ?? 0.5) * WEIGHTS.typeAffinity

  return directLinkScore + sourceOverlapScore + commonNeighborScore + typeAffinityScore
}

export function getRelatedNodes(
  nodeId: string,
  graph: RetrievalGraph,
  limit: number = 5,
): ReadonlyArray<{ node: RetrievalNode; relevance: number }> {
  const sourceNode = graph.nodes.get(nodeId)
  if (!sourceNode) return []

  const scored: Array<{ node: RetrievalNode; relevance: number }> = []
  for (const [id, node] of graph.nodes) {
    if (id === nodeId) continue
    const relevance = calculateRelevance(sourceNode, node, graph)
    if (relevance > 0) {
      scored.push({ node, relevance })
    }
  }

  scored.sort((a, b) => b.relevance - a.relevance)
  return scored.slice(0, limit)
}

function flattenMdFiles(nodes: readonly FileNode[]): FileNode[] {
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

function fileNameToId(fileName: string): string {
  return fileName.replace(/\.md$/, "")
}

function extractFrontmatter(content: string): { title: string; type: string; sources: string[] } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  const fm = fmMatch ? fmMatch[1] : ""
  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m)
  const typeMatch = fm.match(/^type:\s*["']?(.+?)["']?\s*$/m)

  const sources: string[] = []
  const sourcesBlockMatch = fm.match(/^sources:\s*\n((?:\s+-\s+.+\n?)*)/m)
  if (sourcesBlockMatch) {
    const lines = sourcesBlockMatch[1].split("\n")
    for (const line of lines) {
      const itemMatch = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/)
      if (itemMatch) sources.push(itemMatch[1])
    }
  } else {
    const inlineMatch = fm.match(/^sources:\s*\[([^\]]*)\]/m)
    if (inlineMatch) {
      for (const item of inlineMatch[1].split(",")) {
        const trimmed = item.trim().replace(/^["']|["']$/g, "")
        if (trimmed) sources.push(trimmed)
      }
    }
  }

  let title = titleMatch ? titleMatch[1].trim() : ""
  if (!title) {
    const headingMatch = content.match(/^#\s+(.+)$/m)
    title = headingMatch ? headingMatch[1].trim() : ""
  }

  return {
    title,
    type: typeMatch ? typeMatch[1].trim().toLowerCase() : "other",
    sources,
  }
}

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = new RegExp(WIKILINK_REGEX.source, "g")
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

function resolveTarget(raw: string, nodeIds: ReadonlySet<string>): string | null {
  if (nodeIds.has(raw)) return raw

  const normalized = raw.toLowerCase().replace(/\s+/g, "-")
  for (const id of nodeIds) {
    const idLower = id.toLowerCase()
    if (idLower === normalized) return id
    if (idLower === raw.toLowerCase()) return id
    if (idLower.replace(/\s+/g, "-") === normalized) return id
  }
  return null
}

function getNeighbors(node: RetrievalNode): ReadonlySet<string> {
  const neighbors = new Set<string>()
  for (const id of node.outLinks) neighbors.add(id)
  for (const id of node.inLinks) neighbors.add(id)
  return neighbors
}

function getNodeDegree(node: RetrievalNode): number {
  return node.outLinks.size + node.inLinks.size
}
