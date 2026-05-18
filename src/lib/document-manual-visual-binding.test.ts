import { describe, expect, it } from "vitest"

import { extractDocumentManualTables } from "./document-manual-cache-table-parser"
import { bindVisualRowsToOccurrences } from "./document-manual-visual-binding"
import type { DocumentManualVisualOccurrence } from "./document-manual-visual-types"

function makeOccurrence(
  overrides: Partial<DocumentManualVisualOccurrence>,
): DocumentManualVisualOccurrence {
  return {
    occurrenceIndex: 1,
    relPath: "media/operator-manual/img-1.png",
    absPath: "/project/wiki/media/operator-manual/img-1.png",
    mimeType: "image/png",
    width: 32,
    height: 32,
    sha256: "sha-1",
    visualClass: "small_visual",
    docOrder: 1,
    sectionTitle: "运行界面",
    headingPath: ["运行界面"],
    containerKind: "table_cell",
    tableId: 1,
    rowIndex: 0,
    colIndex: 0,
    rowText: "",
    cellText: "",
    rowHeaderText: "图标",
    tableTextSnapshot: "图标 图标描述 未连接 连接中",
    precedingParagraph: "设备状态图标如下表所示。",
    followingParagraph: "表格结束后的说明段落。",
    rowImageCount: 1,
    tableImageCount: 2,
    tableRowCount: 2,
    tableColCount: 2,
    localTextBefore: "",
    localTextAfter: "",
    contextBefore: "",
    contextAfter: "",
    ...overrides,
  }
}

describe("bindVisualRowsToOccurrences", () => {
  it("does not leak another row's description into the current icon", () => {
    const sourceContent = [
      "# 运行界面",
      "",
      "设备状态图标如下表所示。",
      "",
      "| 图标 | 图标描述 |",
      "| --- | --- |",
      "| ![](media/operator-manual/img-1.png) | 超速报警及输出紧急制动显示 |",
      "| ![](media/operator-manual/img-2.png) | 常速运行显示 |",
    ].join("\n")

    const tables = extractDocumentManualTables(sourceContent)
    const groups = bindVisualRowsToOccurrences(tables, [
      makeOccurrence({
        occurrenceIndex: 1,
        relPath: "media/operator-manual/img-1.png",
        absPath: "/project/wiki/media/operator-manual/img-1.png",
        sha256: "sha-1",
        rowIndex: 0,
        colIndex: 0,
        rowText: "超速报警及输出紧急制动显示",
      }),
      makeOccurrence({
        occurrenceIndex: 2,
        relPath: "media/operator-manual/img-2.png",
        absPath: "/project/wiki/media/operator-manual/img-2.png",
        sha256: "sha-2",
        docOrder: 2,
        rowIndex: 1,
        colIndex: 0,
        rowText: "常速运行显示",
      }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].items[0].rowText).toBe("超速报警及输出紧急制动显示")
    expect(groups[0].items[0].cellText).toBe("超速报警及输出紧急制动显示")
    expect(groups[0].items[0].descriptionSource).not.toContain("常速运行显示")
  })

  it("selects the row that actually matched instead of falling back to the first candidate row", () => {
    const sourceContent = [
      "# 运行界面",
      "",
      "| 图标 | 图标描述 |",
      "| --- | --- |",
      "| ![](media/operator-manual/img-1.png) | 初始状态 |",
      "| ![](media/operator-manual/img-2.png) | 连接中 |",
    ].join("\n")

    const tables = extractDocumentManualTables(sourceContent)
    const groups = bindVisualRowsToOccurrences(tables, [
      makeOccurrence({
        occurrenceIndex: 2,
        relPath: "media/operator-manual/img-2.png",
        absPath: "/project/wiki/media/operator-manual/img-2.png",
        sha256: "sha-2",
        docOrder: 2,
        rowIndex: 1,
        colIndex: 0,
        rowText: "连接中",
        cellText: "连接中",
      }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].items).toHaveLength(2)
    expect(groups[0].items[1].rowText).toBe("连接中")
    expect(groups[0].items[1].cellText).toBe("连接中")
  })

  it("keeps same-row placeholders from different tables from collapsing into the first table", () => {
    const sourceContent = [
      "1区，第一组状态",
      "",
      "| 图标 | 图标描述 |",
      "| --- | --- |",
      "| ![](media/operator-manual/img-1.png) | 初始状态 |",
      "| ![](media/operator-manual/img-2.png) | 第一组激活 |",
      "",
      "2区，第二组状态",
      "",
      "| 图标 | 图标描述 |",
      "| --- | --- |",
      "| ![](media/operator-manual/img-3.png) | 初始状态 |",
      "| ![](media/operator-manual/img-4.png) | 第二组激活 |",
    ].join("\n")

    const tables = extractDocumentManualTables(sourceContent)
    const groups = bindVisualRowsToOccurrences(tables, [
      makeOccurrence({
        occurrenceIndex: 1,
        relPath: "media/operator-manual/img-1.png",
        absPath: "/project/wiki/media/operator-manual/img-1.png",
        sha256: "sha-1",
        tableId: 1,
        rowIndex: 0,
        headingPath: ["1区，第一组状态"],
        rowText: "",
        cellText: "",
      }),
      makeOccurrence({
        occurrenceIndex: 2,
        relPath: "media/operator-manual/img-3.png",
        absPath: "/project/wiki/media/operator-manual/img-3.png",
        sha256: "sha-3",
        docOrder: 2,
        tableId: 2,
        rowIndex: 0,
        headingPath: ["2区，第二组状态"],
        rowText: "",
        cellText: "",
      }),
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0].items).toHaveLength(2)
    expect(groups[0].items[0].image).toBe("media/operator-manual/img-1.png")
    expect(groups[0].items[1].image).toBe("media/operator-manual/img-2.png")
    expect(groups[1].items).toHaveLength(2)
    expect(groups[1].items[0].image).toBe("media/operator-manual/img-3.png")
    expect(groups[1].items[1].image).toBe("media/operator-manual/img-4.png")
  })

  it("returns one item per data row even when some rows have no matching occurrence", () => {
    const sourceContent = [
      "# 运行界面",
      "",
      "| 图标 | 图标描述 |",
      "| --- | --- |",
      "| ![](media/operator-manual/img-1.png) | 未连接 |",
      "|  | 连接中 |",
      "|  | 已连接 |",
    ].join("\n")

    const tables = extractDocumentManualTables(sourceContent)
    const groups = bindVisualRowsToOccurrences(tables, [
      makeOccurrence({
        occurrenceIndex: 1,
        relPath: "media/operator-manual/img-1.png",
        absPath: "/project/wiki/media/operator-manual/img-1.png",
        sha256: "sha-1",
        rowIndex: 0,
        colIndex: 0,
        rowText: "未连接",
        cellText: "未连接",
      }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].items.map((item) => ({
      image: item.image,
      rowText: item.rowText,
      cellText: item.cellText,
    }))).toEqual([
      {
        image: "media/operator-manual/img-1.png",
        rowText: "未连接",
        cellText: "未连接",
      },
      {
        image: "",
        rowText: "连接中",
        cellText: "连接中",
      },
      {
        image: "",
        rowText: "已连接",
        cellText: "已连接",
      },
    ])
  })
})
