import { describe, expect, it, vi } from "vitest"

import {
  buildDocumentManualVisualGroups,
  buildUiVisualElementsMarkdown,
  type DocumentManualVisualOccurrence,
} from "./document-manual-visuals"
import { parseVisualGroupBlocks } from "./document-manual-visual-block"

function makeOccurrence(
  overrides: Partial<DocumentManualVisualOccurrence>,
): DocumentManualVisualOccurrence {
  return {
    occurrenceIndex: 1,
    relPath: "media/manual/img-1.png",
    absPath: "/project/wiki/media/manual/img-1.png",
    mimeType: "image/png",
    width: 48,
    height: 48,
    sha256: "sha-1",
    visualClass: "small_visual",
    docOrder: 1,
    sectionTitle: "Device Status",
    containerKind: "table_cell",
    tableId: 1,
    rowIndex: 1,
    colIndex: 0,
    headingPath: ["运行界面", "Device Status"],
    rowText: "未连接",
    cellText: "未连接",
    rowHeaderText: "图标",
    tableTextSnapshot: "图标 图标描述 未连接 连接中 已连接",
    precedingParagraph: "设备连接状态说明",
    followingParagraph: "表格结束后的说明段落。",
    rowImageCount: 1,
    tableImageCount: 3,
    tableRowCount: 4,
    tableColCount: 2,
    localTextBefore: "",
    localTextAfter: "",
    contextBefore: "",
    contextAfter: "",
    ...overrides,
  }
}

function makeSourceContent(): string {
  return [
    "# 运行界面",
    "",
    "设备连接状态说明",
    "",
    "| 图标 | 图标描述 |",
    "| --- | --- |",
    "| ![](media/manual/img-1.png) | 未连接 |",
    "| ![](media/manual/img-2.png) | 连接中 |",
    "| ![](media/manual/img-3.png) | 已连接 |",
    "",
    "表格结束后的说明段落。",
  ].join("\n")
}

describe("document-manual visual grouping", () => {
  it("builds stored groups from markdown tables without collapsing repeated rows", async () => {
    const groups = await buildDocumentManualVisualGroups(
      {
        source: "operator-manual.docx",
        sourceContent: [
          "# 运行界面",
          "",
          "设备连接状态说明",
          "",
          "| 图标 | 图标描述 |",
          "| --- | --- |",
          "| ![](media/manual/img-1.png) | 初始状态 |",
          "| ![](media/manual/img-1.png) | 初始状态 |",
          "| ![](media/manual/img-2.png) | 已连接 |",
          "",
          "表格结束后的说明段落。",
        ].join("\n"),
        occurrences: [
          makeOccurrence({
            occurrenceIndex: 1,
            relPath: "media/manual/img-1.png",
            absPath: "/project/wiki/media/manual/img-1.png",
            sha256: "sha-initial",
            rowIndex: 1,
            rowText: "初始状态",
            cellText: "初始状态",
          }),
          makeOccurrence({
            occurrenceIndex: 2,
            relPath: "media/manual/img-1.png",
            absPath: "/project/wiki/media/manual/img-1.png",
            sha256: "sha-initial",
            docOrder: 2,
            rowIndex: 2,
            rowText: "初始状态",
            cellText: "初始状态",
          }),
          makeOccurrence({
            occurrenceIndex: 3,
            relPath: "media/manual/img-2.png",
            absPath: "/project/wiki/media/manual/img-2.png",
            sha256: "sha-online",
            docOrder: 3,
            rowIndex: 3,
            rowText: "已连接",
            cellText: "已连接",
          }),
        ],
      },
      {
        resolveGroupSummary: async () => ({
          title: "Device Status",
          summary: "展示设备初始状态与已连接状态。",
          context: "设备连接状态说明",
        }),
      },
    )

    expect(groups).toHaveLength(1)
    expect(groups[0].title).toBe("Device Status")
    expect(groups[0].items.map((item) => item.description)).toEqual([
      "初始状态",
      "初始状态",
      "已连接",
    ])
  })

  it("keeps table rows even when no occurrence can be bound to that row", async () => {
    const groups = await buildDocumentManualVisualGroups({
      source: "operator-manual.docx",
      sourceContent: [
        "# 运行界面",
        "",
        "设备连接状态说明",
        "",
        "| 图标 | 图标描述 |",
        "| --- | --- |",
        "| ![](media/manual/img-1.png) | 未连接 |",
        "|  | 连接中 |",
        "|  | 已连接 |",
      ].join("\n"),
      occurrences: [
        makeOccurrence({
          occurrenceIndex: 1,
          relPath: "media/manual/img-1.png",
          absPath: "/project/wiki/media/manual/img-1.png",
          rowIndex: 1,
          rowText: "未连接",
          cellText: "未连接",
        }),
      ],
    })

    expect(groups).toHaveLength(1)
    expect(groups[0].items.map((item) => ({
      image: item.image,
      description: item.description,
    }))).toEqual([
      {
        image: "media/manual/img-1.png",
        description: "未连接",
      },
      {
        image: "",
        description: "连接中",
      },
      {
        image: "",
        description: "已连接",
      },
    ])
  })

  it("uses row-local text and does not mix in other rows", async () => {
    const sourceContent = [
      "# 运行界面",
      "",
      "报警图标说明",
      "",
      "| 图标 | 图标描述 |",
      "| --- | --- |",
      "| ![](media/manual/img-1.png) | 超速报警及输出紧急制动显示 |",
      "| ![](media/manual/img-2.png) | 常速运行显示 |",
    ].join("\n")

    const groups = await buildDocumentManualVisualGroups({
      source: "operator-manual.docx",
      sourceContent,
      occurrences: [
        makeOccurrence({
          relPath: "media/manual/img-1.png",
          absPath: "/project/wiki/media/manual/img-1.png",
          rowIndex: 1,
          rowText: "超速报警及输出紧急制动显示",
          cellText: "超速报警及输出紧急制动显示",
          headingPath: ["运行界面", "超速报警"],
          sectionTitle: "超速报警",
        }),
        makeOccurrence({
          occurrenceIndex: 2,
          relPath: "media/manual/img-2.png",
          absPath: "/project/wiki/media/manual/img-2.png",
          sha256: "sha-2",
          docOrder: 2,
          rowIndex: 2,
          rowText: "常速运行显示",
          cellText: "常速运行显示",
          headingPath: ["运行界面", "超速报警"],
          sectionTitle: "超速报警",
        }),
      ],
    })

    expect(groups).toHaveLength(1)
    expect(groups[0].items.map((item) => item.description)).toEqual([
      "超速报警及输出紧急制动显示",
      "常速运行显示",
    ])
    expect(groups[0].items[0].description).not.toContain("常速运行")
  })

  it("prefers row and cell text over visual captioning for icon descriptions", async () => {
    const resolveMemberDescription = vi.fn(async () => ({
      description: "视觉模型描述",
    }))

    const groups = await buildDocumentManualVisualGroups(
      {
        source: "operator-manual.docx",
        sourceContent: makeSourceContent(),
        occurrences: [
          makeOccurrence({
            rowIndex: 1,
            rowText: "未连接",
            cellText: "未连接",
          }),
        ],
      },
      {
        resolveMemberDescription,
        resolveGroupSummary: async () => ({
          title: "空文本图标组",
          summary: "视觉模型兜底描述。",
          context: "图标 图标描述",
        }),
      },
    )

    expect(resolveMemberDescription).not.toHaveBeenCalled()
    expect(groups).toHaveLength(1)
    expect(groups[0].items[0].description).toBe("未连接")
  })

  it("only uses VLM when row-local text is empty", async () => {
    const resolveMemberDescription = vi.fn(async () => ({
      description: "视觉模型描述",
    }))

    const groups = await buildDocumentManualVisualGroups(
      {
        source: "operator-manual.docx",
        sourceContent: [
          "# 运行界面",
          "",
          "| 图标 | 图标描述 |",
          "| --- | --- |",
          "| ![](media/manual/img-1.png) |  |",
        ].join("\n"),
        occurrences: [
          makeOccurrence({
            rowIndex: 1,
            rowText: "",
            cellText: "",
            localTextBefore: "",
            localTextAfter: "",
          }),
        ],
      },
      {
        resolveMemberDescription,
      },
    )

    expect(resolveMemberDescription).toHaveBeenCalledTimes(1)
    expect(groups).toHaveLength(1)
    expect(groups[0].items[0].description).toBe("视觉模型描述")
  })
})

describe("document-manual visual markdown", () => {
  it("renders a single structured block per visual group for UI Visual Elements", () => {
    const markdown = buildUiVisualElementsMarkdown([
      {
        id: "vg-operator-manual-1",
        source: "operator-manual.docx",
        headingPath: ["运行界面", "Device Status"],
        title: "Device Status",
        summary: "展示设备未连接、连接中与已连接三种状态。",
        tableContext: "设备连接状态说明 图标 图标描述 未连接 连接中 已连接",
        items: [
          {
            image: "media/manual/img-1.png",
            description: "未连接",
            rowText: "未连接",
            cellText: "未连接",
            headerText: "图标描述",
          },
          {
            image: "media/manual/img-2.png",
            description: "连接中",
            rowText: "连接中",
            cellText: "连接中",
            headerText: "图标描述",
          },
        ],
      },
    ])

    expect(markdown).toContain("## UI Visual Elements")
    expect(markdown).toContain("```llm-wiki-visual-group")
    expect(markdown).not.toContain("<!-- llm-wiki:visual-group")
    expect(markdown).toContain("heading-path: 运行界面 > Device Status")
    expect(markdown).not.toContain("### Device Status")
    expect(markdown).not.toContain("| 图标 | 图标描述 |")
    expect(markdown).not.toContain('![](media/manual/img-1.png "llm-wiki-visual-group-icon")')

    const parsed = parseVisualGroupBlocks(markdown)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].items[0].description).toBe("未连接")
    expect(parsed[0].tableContext).toContain("设备连接状态说明")
  })
})
