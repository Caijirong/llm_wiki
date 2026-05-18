// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { describe, expect, it, vi } from "vitest"
import type { Node as ProseMirrorNode } from "@milkdown/prose/model"

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `tauri-asset:${path}`,
}))

import { createVisualGroupAwareCodeBlockNodeView } from "./wiki-visual-group-node-view"
import { VISUAL_GROUP_BLOCK_FENCE_INFO } from "@/lib/document-manual-visual-block"

function codeBlockNode(
  body: string,
  language = VISUAL_GROUP_BLOCK_FENCE_INFO,
): ProseMirrorNode {
  return {
    attrs: { language },
    textContent: body,
  } as unknown as ProseMirrorNode
}

describe("createVisualGroupAwareCodeBlockNodeView", () => {
  const projectPath = "/Users/me/MyWiki"

  it("renders visual-group blocks as a single derived table view", () => {
    const body = [
      "id: vg-operator-manual-1",
      "source: operator-manual.docx",
      "heading-path: 运行界面 > Device Status",
      "title: Device Status",
      "summary: 展示设备未连接、连接中与已连接两种状态。",
      "table-context: 设备连接状态说明 图标 图标描述 未连接 连接中",
      "item:",
      "  image: media/manual/img-1.png",
      "  description: 未连接",
      "  row-text: 未连接",
      "  cell-text: 未连接",
      "  header-text: 图标描述",
      "item:",
      "  image: media/manual/img-2.png",
      "  description: 连接中",
      "  row-text: 连接中",
      "  cell-text: 连接中",
      "  header-text: 图标描述",
    ].join("\n")

    const view = createVisualGroupAwareCodeBlockNodeView(projectPath)(
      codeBlockNode(body),
      null as never,
      null as never,
      [],
      null as never,
    )

    expect(view.dom.textContent).toContain("Device Status")
    expect(view.dom.textContent).toContain("展示设备未连接、连接中与已连接两种状态。")
    expect(view.dom.textContent).not.toContain("id: vg-operator-manual-1")

    const images = view.dom.querySelectorAll("img")
    expect(images).toHaveLength(2)
    expect(images[0]?.getAttribute("src")).toBe(
      "tauri-asset:/Users/me/MyWiki/wiki/media/manual/img-1.png",
    )
    expect(images[0]?.getAttribute("alt")).toBe("")
    expect(images[0]?.className).toContain("w-40")
  })

  it("keeps text-only rows when a visual-group member has no image", () => {
    const body = [
      "id: vg-operator-manual-2",
      "source: operator-manual.docx",
      "heading-path: 运行界面 > Device Status",
      "title: Device Status",
      "summary: 展示文本型状态行。",
      "table-context: 设备连接状态说明 图标 图标描述 未连接 已连接",
      "item:",
      "  image: media/manual/img-1.png",
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
    ].join("\n")

    const view = createVisualGroupAwareCodeBlockNodeView(projectPath)(
      codeBlockNode(body),
      null as never,
      null as never,
      [],
      null as never,
    )

    expect(view.dom.textContent).toContain("已连接")
    expect(view.dom.querySelectorAll("img")).toHaveLength(1)
  })

  it("falls back to a normal code block view for non visual-group fences", () => {
    const view = createVisualGroupAwareCodeBlockNodeView(projectPath)(
      codeBlockNode("const a = 1", "ts"),
      null as never,
      null as never,
      [],
      null as never,
    )

    expect(view.dom.tagName).toBe("PRE")
    expect(view.dom.querySelector("code")?.className).toBe("language-ts")
  })
})
