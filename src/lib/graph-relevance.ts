import { readFile, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import {
  buildRetrievalGraphWithAdapter,
  calculateRelevance,
  getRelatedNodes,
  type RetrievalGraph,
  type RetrievalNode,
} from "./retrieval-graph-core.js"

export type { RetrievalGraph, RetrievalNode } from "./retrieval-graph-core.js"
export { calculateRelevance, getRelatedNodes } from "./retrieval-graph-core.js"

let cachedGraph: RetrievalGraph | null = null

export async function buildRetrievalGraph(
  projectPath: string,
  dataVersion: number = 0,
): Promise<RetrievalGraph> {
  if (cachedGraph && cachedGraph.dataVersion === dataVersion) {
    return cachedGraph
  }

  const graph = await buildRetrievalGraphWithAdapter(
    `${normalizePath(projectPath)}/wiki`,
    {
      listDirectory,
      readText: readFile,
    },
    dataVersion,
  )

  cachedGraph = graph
  return graph
}

export function clearGraphCache(): void {
  cachedGraph = null
}
