import { describe, expect, it } from "vitest"

import { buildRetrievalContextBundle, type RetrievalSearchResult } from "@/lib/retrieval-core"

function makeSearchResult(
  overrides: Partial<RetrievalSearchResult> = {},
): RetrievalSearchResult {
  return {
    path: "/wiki/entities/alpha.md",
    title: "Alpha",
    snippet: "alpha snippet",
    titleMatch: true,
    score: 10,
    ...overrides,
  }
}

describe("buildRetrievalContextBundle", () => {
  it("prioritizes title hits before graph expansions and keeps page references", async () => {
    const bundle = await buildRetrievalContextBundle({
      projectPath: "/wiki-project",
      query: "alpha relationships",
      maxContextSize: 4000,
      index: "# Index\n- [[alpha]]",
      purpose: "# Purpose\nAnswer well",
      searchResults: [
        makeSearchResult({
          path: "/wiki-project/wiki/entities/alpha.md",
          title: "Alpha",
          titleMatch: true,
        }),
      ],
      graphExpansions: [
        {
          title: "Beta",
          path: "/wiki-project/wiki/concepts/beta.md",
          relevance: 3.2,
        },
      ],
      overviewPath: "/wiki-project/wiki/overview.md",
      readText: async (path) => {
        if (path.endsWith("alpha.md")) return "# Alpha\nAlpha content"
        if (path.endsWith("beta.md")) return "# Beta\nBeta content"
        if (path.endsWith("overview.md")) return "# Overview\nOverview content"
        return ""
      },
    })

    expect(bundle.pages.map((page) => page.title)).toEqual(["Alpha", "Beta"])
    expect(bundle.references).toEqual([
      { title: "Alpha", path: "wiki/entities/alpha.md" },
      { title: "Beta", path: "wiki/concepts/beta.md" },
    ])
  })

  it("falls back to overview when no search or graph pages are available", async () => {
    const bundle = await buildRetrievalContextBundle({
      projectPath: "/wiki-project",
      query: "missing topic",
      maxContextSize: 4000,
      index: "",
      purpose: "",
      searchResults: [],
      graphExpansions: [],
      overviewPath: "/wiki-project/wiki/overview.md",
      readText: async (path) =>
        path.endsWith("overview.md") ? "# Overview\nFallback content" : "",
    })

    expect(bundle.pages).toHaveLength(1)
    expect(bundle.pages[0]?.title).toBe("Overview")
    expect(bundle.pages[0]?.priority).toBe(3)
  })

  it("respects page budget and skips lower priority pages when budget is exhausted", async () => {
    const bundle = await buildRetrievalContextBundle({
      projectPath: "/wiki-project",
      query: "alpha budget",
      maxContextSize: 100,
      index: "",
      purpose: "",
      searchResults: [
        makeSearchResult({
          path: "/wiki-project/wiki/entities/alpha.md",
          title: "Alpha",
          titleMatch: true,
        }),
        makeSearchResult({
          path: "/wiki-project/wiki/entities/gamma.md",
          title: "Gamma",
          titleMatch: false,
          score: 5,
        }),
      ],
      graphExpansions: [
        {
          title: "Beta",
          path: "/wiki-project/wiki/concepts/beta.md",
          relevance: 3.1,
        },
      ],
      overviewPath: "/wiki-project/wiki/overview.md",
      readText: async (path) => {
        if (path.endsWith("alpha.md")) return "# Alpha\n" + "A".repeat(120)
        if (path.endsWith("gamma.md")) return "# Gamma\n" + "G".repeat(260)
        if (path.endsWith("beta.md")) return "# Beta\n" + "B".repeat(260)
        return ""
      },
    })

    expect(bundle.pages.map((page) => page.title)).toEqual(["Alpha"])
  })
})
