#!/usr/bin/env node

import path from "node:path"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import * as z from "zod/v4"

import {
  buildWikiContext,
  type SearchMode,
  isWikiProject,
  listWikiProjects,
  readWikiPage,
  searchWiki,
} from "../lib/wiki-query.js"
import {
  getVectorSearchAvailability,
  vectorSearchWiki,
} from "./vector-search.js"

const DEFAULT_WORKSPACE_ROOT = process.env.LLM_WIKI_ROOT
  ? path.resolve(process.env.LLM_WIKI_ROOT)
  : process.cwd()

const SEARCH_RESULT_SCHEMA = z.object({
  title: z.string(),
  relativePath: z.string(),
  score: z.number(),
  snippet: z.string(),
  titleMatch: z.boolean(),
})

const PAGE_SCHEMA = z.object({
  title: z.string(),
  relativePath: z.string(),
  content: z.string(),
})

const CONTEXT_SCHEMA = z.object({
  projectPath: z.string(),
  mode: z.enum(["keyword", "semantic", "hybrid"]),
  purpose: z.string(),
  schema: z.string(),
  index: z.string(),
  pages: z.array(PAGE_SCHEMA),
})

const server = new McpServer({
  name: "llm-wiki-mcp-server",
  version: "0.3.1",
})

server.registerTool(
  "llm_wiki_list_projects",
  {
    title: "List LLM Wiki Projects",
    description: "Discover LLM Wiki projects under a workspace root. Use this first when you do not know which project_path to pass to other tools.",
    inputSchema: {
      root_path: z.string().optional().describe("Workspace root to scan. Defaults to the LLM_WIKI_ROOT env var or the current working directory."),
    },
    outputSchema: {
      workspaceRoot: z.string(),
      projects: z.array(z.object({
        name: z.string(),
        path: z.string(),
      })),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ root_path }) => {
    const workspaceRoot = path.resolve(root_path ?? DEFAULT_WORKSPACE_ROOT)
    const projects = await listWikiProjects(workspaceRoot)
    const structuredContent = { workspaceRoot, projects }

    if (projects.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No LLM Wiki projects found under ${workspaceRoot}. Pass a different root_path or set LLM_WIKI_ROOT to a folder that contains schema.md and wiki/index.md.`,
        }],
        structuredContent,
      }
    }

    return {
      content: [{
        type: "text",
        text: [
          `Found ${projects.length} LLM Wiki project(s) under ${workspaceRoot}:`,
          ...projects.map((project) => `- ${project.name}: ${project.path}`),
        ].join("\n"),
      }],
      structuredContent,
    }
  },
)

server.registerTool(
  "llm_wiki_search",
  {
    title: "Search LLM Wiki",
    description: "Search wiki markdown pages by keyword relevance. Returns top matches with title boosts and snippets.",
    inputSchema: {
      query: z.string().min(1).describe("Search query to run against wiki markdown pages."),
      project_path: z.string().optional().describe("Absolute or relative path to the target LLM Wiki project. Optional when the current directory is already a wiki project or only one project exists under LLM_WIKI_ROOT."),
      limit: z.number().int().min(1).max(20).default(10).describe("Maximum number of search results to return."),
      mode: z.enum(["keyword", "semantic", "hybrid"]).default("hybrid").describe("Search mode. semantic and hybrid require LLM_WIKI_EMBEDDING_ENDPOINT and LLM_WIKI_EMBEDDING_MODEL."),
    },
    outputSchema: {
      projectPath: z.string(),
      query: z.string(),
      mode: z.enum(["keyword", "semantic", "hybrid"]),
      results: z.array(SEARCH_RESULT_SCHEMA),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, project_path, limit, mode }) => {
    const projectPath = await resolveProjectPath(project_path)
    const searchOptions = createSearchOptions(projectPath, mode, limit)
    const results = await searchWiki(projectPath, query, searchOptions)
    const structuredContent = {
      projectPath,
      query,
      mode: searchOptions.mode,
      results: results.map((result) => ({
        title: result.title,
        relativePath: result.relativePath,
        score: result.score,
        snippet: result.snippet,
        titleMatch: result.titleMatch,
      })),
    }

    return {
      content: [{
        type: "text",
        text: results.length > 0
          ? [
              `Top ${searchOptions.mode} wiki matches for "${query}" in ${projectPath}:`,
              ...(searchOptions.warning ? [searchOptions.warning] : []),
              ...results.map((result, index) =>
                `${index + 1}. ${result.title} (${result.relativePath}) score=${result.score}${result.titleMatch ? " title-match" : ""}\n   ${result.snippet}`,
              ),
            ].join("\n")
          : [
              `No ${searchOptions.mode} wiki matches found for "${query}" in ${projectPath}.`,
              ...(searchOptions.warning ? [searchOptions.warning] : []),
            ].join("\n"),
      }],
      structuredContent,
    }
  },
)

server.registerTool(
  "llm_wiki_read_page",
  {
    title: "Read LLM Wiki Page",
    description: "Read a single wiki page by relative path like entities/openai.md or by page id like openai.",
    inputSchema: {
      path_or_id: z.string().min(1).describe("Wiki-relative path or bare page id to read."),
      project_path: z.string().optional().describe("Absolute or relative path to the target LLM Wiki project."),
      max_chars: z.number().int().min(200).max(50000).default(12000).describe("Maximum page content characters to return."),
    },
    outputSchema: {
      projectPath: z.string(),
      page: PAGE_SCHEMA.extend({
        exists: z.boolean(),
      }),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ path_or_id, project_path, max_chars }) => {
    const projectPath = await resolveProjectPath(project_path)
    const page = await readWikiPage(projectPath, path_or_id)
    const truncatedPage = {
      exists: page.exists,
      title: page.title,
      relativePath: page.relativePath,
      content: truncate(page.content, max_chars),
    }

    return {
      content: [{
        type: "text",
        text: page.exists
          ? `# ${page.title}\n\nPath: ${page.relativePath}\n\n${truncate(page.content, max_chars)}`
          : `Page "${path_or_id}" was not found in ${projectPath}. Try llm_wiki_search first to discover the correct relativePath.`,
      }],
      structuredContent: {
        projectPath,
        page: truncatedPage,
      },
    }
  },
)

server.registerTool(
  "llm_wiki_get_context",
  {
    title: "Get LLM Wiki Context Bundle",
    description: "Return a compact answering bundle: purpose.md, schema.md, wiki/index.md, and the most relevant wiki pages for a query.",
    inputSchema: {
      query: z.string().min(1).describe("Question or topic that needs supporting wiki context."),
      project_path: z.string().optional().describe("Absolute or relative path to the target LLM Wiki project."),
      max_pages: z.number().int().min(1).max(10).default(5).describe("Maximum number of wiki pages to include."),
      page_char_limit: z.number().int().min(200).max(20000).default(4000).describe("Maximum number of characters to include per page."),
      mode: z.enum(["keyword", "semantic", "hybrid"]).default("hybrid").describe("Retrieval mode used to choose supporting pages."),
    },
    outputSchema: CONTEXT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, project_path, max_pages, page_char_limit, mode }) => {
    const projectPath = await resolveProjectPath(project_path)
    const searchOptions = createSearchOptions(projectPath, mode, max_pages)
    const context = await buildWikiContext(projectPath, query, max_pages, searchOptions)
    const structuredContent = {
      ...context,
      mode: searchOptions.mode,
      pages: context.pages.map((page) => ({
        title: page.title,
        relativePath: page.relativePath,
        content: truncate(page.content, page_char_limit),
      })),
    }

    return {
      content: [{
        type: "text",
        text: [
          `Context bundle for "${query}" in ${projectPath} using ${searchOptions.mode} retrieval`,
          ...(searchOptions.warning ? ["", searchOptions.warning] : []),
          "",
          structuredContent.purpose ? "## purpose.md\n" + structuredContent.purpose : "## purpose.md\n(not found)",
          "",
          structuredContent.schema ? "## schema.md\n" + structuredContent.schema : "## schema.md\n(not found)",
          "",
          structuredContent.index ? "## wiki/index.md\n" + structuredContent.index : "## wiki/index.md\n(not found)",
          "",
          "## Relevant Pages",
          ...structuredContent.pages.map((page, index) =>
            `### [${index + 1}] ${page.title}\nPath: ${page.relativePath}\n\n${page.content}`,
          ),
        ].join("\n"),
      }],
      structuredContent,
    }
  },
)

async function resolveProjectPath(projectPath?: string): Promise<string> {
  if (projectPath) {
    const resolved = path.resolve(projectPath)
    if (await isWikiProject(resolved)) {
      return resolved
    }
    throw new Error(
      `Invalid project_path: ${resolved}. Expected a directory containing schema.md and wiki/index.md.`,
    )
  }

  if (await isWikiProject(DEFAULT_WORKSPACE_ROOT)) {
    return DEFAULT_WORKSPACE_ROOT
  }

  const projects = await listWikiProjects(DEFAULT_WORKSPACE_ROOT)

  if (projects.length === 1) {
    return projects[0].path
  }

  if (projects.length === 0) {
    throw new Error(
      `No LLM Wiki project found under ${DEFAULT_WORKSPACE_ROOT}. Pass project_path explicitly or set LLM_WIKI_ROOT.`,
    )
  }

  throw new Error(
    [
      `Multiple LLM Wiki projects found under ${DEFAULT_WORKSPACE_ROOT}.`,
      "Pass project_path explicitly. Available projects:",
      ...projects.map((project) => `- ${project.path}`),
    ].join("\n"),
  )
}

function createSearchOptions(
  projectPath: string,
  mode: SearchMode,
  limit: number,
): {
  mode: SearchMode
  limit: number
  vectorSearch?: (query: string, limit: number) => Promise<Array<{ id: string; score: number }>>
  warning?: string
} {
  if (mode === "keyword") {
    return { mode, limit }
  }

  const availability = getVectorSearchAvailability()
  if (!availability.available) {
    if (mode === "semantic") {
      throw new Error(availability.reason)
    }
    return {
      mode: "keyword",
      limit,
      warning: `Hybrid retrieval fell back to keyword-only mode. ${availability.reason}`,
    }
  }

  return {
    mode,
    limit,
    vectorSearch: async (query: string, innerLimit: number) =>
      vectorSearchWiki(projectPath, query, innerLimit),
  }
}

function truncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return `${content.slice(0, maxChars)}\n\n...[truncated]`
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`LLM Wiki MCP server running on stdio. Workspace root: ${DEFAULT_WORKSPACE_ROOT}`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(message)
  process.exit(1)
})
