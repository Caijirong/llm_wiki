import path from "node:path"

import {
  listWikiProjects,
  type WikiProjectInfo,
} from "../lib/wiki-query.js"

export interface ProjectDiscoveryResult {
  workspaceRoot: string
  projects: WikiProjectInfo[]
  fallbackUsed: boolean
}

export async function resolveProjectDiscoveryRoot(
  rootPath: string | undefined,
  defaultWorkspaceRoot: string,
): Promise<ProjectDiscoveryResult> {
  const requestedRoot = path.resolve(rootPath ?? defaultWorkspaceRoot)
  const requestedProjects = await listWikiProjects(requestedRoot)

  if (!rootPath || requestedProjects.length > 0 || requestedRoot === defaultWorkspaceRoot) {
    return {
      workspaceRoot: requestedRoot,
      projects: requestedProjects,
      fallbackUsed: false,
    }
  }

  const defaultProjects = await listWikiProjects(defaultWorkspaceRoot)
  if (defaultProjects.length > 0) {
    return {
      workspaceRoot: defaultWorkspaceRoot,
      projects: defaultProjects,
      fallbackUsed: true,
    }
  }

  return {
    workspaceRoot: requestedRoot,
    projects: requestedProjects,
    fallbackUsed: false,
  }
}
