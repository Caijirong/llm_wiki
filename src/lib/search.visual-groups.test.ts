import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import path from "node:path"
import fs from "node:fs/promises"

import { realFs, createTempProject } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

import { searchWiki } from "./search"
import { useWikiStore } from "@/stores/wiki-store"

describe("searchWiki visual groups", () => {
  let tmp: Awaited<ReturnType<typeof createTempProject>> | null = null

  beforeEach(() => {
    useWikiStore.getState().setEmbeddingConfig({
      enabled: false,
      endpoint: "",
      apiKey: "",
      model: "",
    })
  })

  afterEach(async () => {
    if (tmp) {
      await tmp.cleanup()
      tmp = null
    }
  })

  it("recalls visual groups by title, context, and member label", async () => {
    tmp = await createTempProject("search-visual-groups")
    const pagePath = path.join(tmp.path, "wiki", "sources", "operator-manual.md")
    await fs.mkdir(path.dirname(pagePath), { recursive: true })
    await fs.writeFile(
      pagePath,
      [
        "---",
        "type: source",
        'title: "Source: operator-manual.docx"',
        "created: 2026-05-15",
        "updated: 2026-05-15",
        'sources: ["operator-manual.docx"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Source: operator-manual.docx",
        "",
        "## UI Visual Elements",
        "",
        "```llm-wiki-visual-group",
        "id: vg-operator-manual-1",
        "source: operator-manual.docx",
        "heading-path: 运行界面 > Device Status",
        "title: Device Status",
        "summary: 展示设备未连接、连接中与已连接三种状态。",
        "table-context: 设备连接状态说明 图标 图标描述 未连接 连接中 已连接",
        "item:",
        "  image: media/operator-manual/img-1.png",
        "  description: 未连接",
        "  row-text: 未连接",
        "  cell-text: 未连接",
        "  header-text: 图标描述",
        "item:",
        "  image: media/operator-manual/img-2.png",
        "  description: 连接中",
        "  row-text: 连接中",
        "  cell-text: 连接中",
        "  header-text: 图标描述",
        "item:",
        "  image: media/operator-manual/img-3.png",
        "  description: 已连接",
        "  row-text: 已连接",
        "  cell-text: 已连接",
        "  header-text: 图标描述",
        "```",
        "",
      ].join("\n"),
      "utf8",
    )

    for (const query of ["Device Status", "设备连接状态说明", "连接中"]) {
      const results = await searchWiki(tmp.path, query)

      expect(results).toHaveLength(1)
      expect(results[0].visualGroups).toHaveLength(1)
      expect(results[0].visualGroups[0].title).toBe("Device Status")
      expect(results[0].visualGroups[0].members.map((member) => member.label)).toEqual([
        "未连接",
        "连接中",
        "已连接",
      ])
      expect(results[0].images).toHaveLength(0)
    }
  })

  it("keeps text-only visual-group members searchable even when their image field is blank", async () => {
    tmp = await createTempProject("search-visual-groups-text-only")
    const pagePath = path.join(tmp.path, "wiki", "sources", "operator-manual.md")
    await fs.mkdir(path.dirname(pagePath), { recursive: true })
    await fs.writeFile(
      pagePath,
      [
        "---",
        "type: source",
        'title: "Source: operator-manual.docx"',
        "created: 2026-05-15",
        "updated: 2026-05-15",
        'sources: ["operator-manual.docx"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Source: operator-manual.docx",
        "",
        "## UI Visual Elements",
        "",
        "```llm-wiki-visual-group",
        "id: vg-operator-manual-2",
        "source: operator-manual.docx",
        "heading-path: 运行界面 > Device Status",
        "title: Device Status",
        "summary: 展示文本型状态行。",
        "table-context: 设备连接状态说明 图标 图标描述 未连接 已连接",
        "item:",
        "  image: media/operator-manual/img-1.png",
        "  description: 未连接",
        "  row-text: 未连接",
        "  cell-text: 未连接",
        "  header-text: 图标描述",
        "item:",
        "  image: ",
        "  description: 已连接",
        "  row-text: 已连接",
        "  cell-text: 已连接",
        "  header-text: 图标描述",
        "```",
        "",
      ].join("\n"),
      "utf8",
    )

    const results = await searchWiki(tmp.path, "已连接")

    expect(results).toHaveLength(1)
    expect(results[0].visualGroups).toHaveLength(1)
    expect(results[0].visualGroups[0].members.map((member) => member.label)).toEqual([
      "未连接",
      "已连接",
    ])
    expect(results[0].visualGroups[0].members[1].url).toBe("")
    expect(results[0].images).toHaveLength(0)
  })
})
