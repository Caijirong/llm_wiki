import { describe, expect, it } from "vitest"

import { extractDocumentManualTables } from "./document-manual-cache-table-parser"

describe("extractDocumentManualTables", () => {
  it("keeps a multi-page word table as one markdown table group", () => {
    const sourceContent = [
      "# 运行界面",
      "",
      "设备状态图标如下表所示。",
      "",
      "| 图标 | 图标描述 |",
      "| --- | --- |",
      "| ![](media/operator-manual/img-1.png) | 未连接 |",
      "| ![](media/operator-manual/img-2.png) | 连接中 |",
      "| ![](media/operator-manual/img-3.png) | 已连接 |",
      "",
      "表格结束后的说明段落。",
    ].join("\n")

    const tables = extractDocumentManualTables(sourceContent)

    expect(tables).toHaveLength(1)
    expect(tables[0].headingPath).toEqual(["运行界面"])
    expect(tables[0].precedingParagraph).toBe("设备状态图标如下表所示。")
    expect(tables[0].followingParagraph).toBe("表格结束后的说明段落。")
    expect(tables[0].header).toEqual(["图标", "图标描述"])
    expect(tables[0].rows).toHaveLength(3)
    expect(tables[0].rows[1]).toEqual(["![](media/operator-manual/img-2.png)", "连接中"])
  })

  it("infers docx section titles as headingPath when markdown headings are absent", () => {
    const sourceContent = [
      "MMI显示图例说明",
      "",
      "1区，超速报警及输出紧急制动显示",
      "",
      "列车当前速度超过推荐速度或输出紧急制动时，按照下表规定的图标进行报警提示。",
      "",
      "| 序号 | 图标 | 颜色 | 含义 |",
      "| --- | --- | --- | --- |",
      "| 1 | ![](media/operator-manual/img-1.png) | 黑色 | 初始状态 |",
      "| 2 | ![](media/operator-manual/img-2.png) | 橙色 | 超速报警 |",
    ].join("\n")

    const tables = extractDocumentManualTables(sourceContent)

    expect(tables).toHaveLength(1)
    expect(tables[0].headingPath).toEqual(["1区，超速报警及输出紧急制动显示"])
  })
})
