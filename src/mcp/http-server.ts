#!/usr/bin/env node

import http from "node:http"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"

import {
  type ConfiguredServerTarget,
  createWikiMcpServer,
  validateConfiguredTarget,
} from "./server.js"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 18765
const MCP_PATH = "/mcp"

export interface ParsedCliArgs {
  host: string
  port: number
  target: ConfiguredServerTarget
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let host = DEFAULT_HOST
  let port = DEFAULT_PORT
  let projectPath: string | undefined
  let workspaceRoot: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === "--project") {
      projectPath = requireValue(argv, ++index, "--project")
      continue
    }

    if (arg === "--workspace") {
      workspaceRoot = requireValue(argv, ++index, "--workspace")
      continue
    }

    if (arg === "--host") {
      host = requireValue(argv, ++index, "--host")
      continue
    }

    if (arg === "--port") {
      const rawPort = requireValue(argv, ++index, "--port")
      const parsed = Number(rawPort)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`Invalid --port value: ${rawPort}. Expected an integer between 1 and 65535.`)
      }
      port = parsed
      continue
    }

    if (arg === "--help" || arg === "-h") {
      throw new Error(getUsage())
    }

    throw new Error(`Unknown argument: ${arg}\n\n${getUsage()}`)
  }

  if (Boolean(projectPath) === Boolean(workspaceRoot)) {
    throw new Error(`Pass exactly one of --project or --workspace.\n\n${getUsage()}`)
  }

  return {
    host,
    port,
    target: projectPath
      ? {
          kind: "project",
          projectPath: path.resolve(projectPath),
        }
      : {
          kind: "workspace",
          workspaceRoot: path.resolve(workspaceRoot!),
        },
  }
}

export async function startHttpMcpServer(
  options: ParsedCliArgs,
): Promise<http.Server> {
  await validateConfiguredTarget(options.target)

  const server = http.createServer(async (req, res) => {
    if (!req.url || req.url.split("?")[0] !== MCP_PATH) {
      res.statusCode = 404
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ error: "Not Found" }))
      return
    }

    if (!req.method || !["GET", "POST", "DELETE"].includes(req.method)) {
      res.statusCode = 405
      res.setHeader("allow", "GET, POST, DELETE")
      res.end()
      return
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    const mcpServer = createWikiMcpServer({
      target: options.target,
    })

    try {
      await mcpServer.connect(transport)
      await transport.handleRequest(req, res)
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
          id: null,
        }))
      }
    } finally {
      await mcpServer.close().catch(() => {})
      await transport.close().catch(() => {})
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.host, () => {
      server.off("error", reject)
      resolve()
    })
  })

  return server
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.\n\n${getUsage()}`)
  }
  return value
}

function getUsage(): string {
  return [
    "Usage:",
    "  llm-wiki-mcp --project /absolute/path/to/wiki [--host 127.0.0.1] [--port 18765]",
    "  llm-wiki-mcp --workspace /absolute/path/to/workspace [--host 127.0.0.1] [--port 18765]",
  ].join("\n")
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2))
  const server = await startHttpMcpServer(args)

  const targetLabel = args.target.kind === "project"
    ? `project=${args.target.projectPath}`
    : `workspace=${args.target.workspaceRoot}`

  console.error(
    `LLM Wiki MCP HTTP server listening on http://${args.host}:${args.port}${MCP_PATH} (${targetLabel})`,
  )

  const closeServer = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  process.once("SIGINT", () => {
    void closeServer().finally(() => process.exit(0))
  })
  process.once("SIGTERM", () => {
    void closeServer().finally(() => process.exit(0))
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error(message)
    process.exit(1)
  })
}
