import { readFile } from "node:fs/promises"
import path from "node:path"

import { describe, expect, it } from "vitest"

const packageRoot = path.resolve("packages/llm-wiki-mcp")

describe("llm-wiki-mcp workspace package", () => {
  it("defines a publishable MCP bin package", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as {
      name?: string
      private?: boolean
      type?: string
      bin?: Record<string, string>
      files?: string[]
      scripts?: Record<string, string>
    }

    expect(packageJson.name).toBe("@haowan36/llm-wiki-mcp")
    expect(packageJson.private).toBe(false)
    expect(packageJson.type).toBe("module")
    expect(packageJson.bin).toEqual({
      "llm-wiki-mcp": "./dist/mcp/http-server.js",
    })
    expect(packageJson.files).toEqual(
      expect.arrayContaining(["dist", "README.md"]),
    )
    expect(packageJson.scripts?.build).toBe("tsc -p tsconfig.json")
    expect(packageJson.scripts?.start).toBe("node dist/mcp/http-server.js")
  })
})
