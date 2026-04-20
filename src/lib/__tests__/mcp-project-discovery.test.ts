import { describe, expect, it } from "vitest"

import { parseCliArgs } from "@/mcp/http-server"

describe("parseCliArgs", () => {
  it("requires exactly one of --project or --workspace", () => {
    expect(() => parseCliArgs([])).toThrow(/--project or --workspace/i)
    expect(() =>
      parseCliArgs(["--project", "/tmp/wiki-a", "--workspace", "/tmp/workspace"])
    ).toThrow(/exactly one/i)
  })

  it("does not read LLM_WIKI_ROOT and uses the explicit project", () => {
    process.env.LLM_WIKI_ROOT = "/tmp/wiki-from-env"

    expect(
      parseCliArgs(["--project", "/tmp/wiki-a"])
    ).toMatchObject({
      target: {
        kind: "project",
        projectPath: "/tmp/wiki-a",
      },
      host: "127.0.0.1",
      port: 18765,
    })
  })
})
