// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import type { Node as ProseMirrorNode } from "@milkdown/prose/model"

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `tauri-asset:${path}`,
}))

import { createResolvedImageNodeView } from "./wiki-image-node-view"
import { VISUAL_GROUP_ICON_TITLE } from "@/lib/document-manual-visual-block"

function imageNode(attrs: Record<string, unknown>): ProseMirrorNode {
  return { attrs } as ProseMirrorNode
}

describe("createResolvedImageNodeView", () => {
  const projectPath = "/Users/me/MyWiki"

  it("renders markdown image srcs through the project-aware resolver", () => {
    const view = createResolvedImageNodeView(projectPath)(
      imageNode({
        src: "media/manual/img-12.png",
        alt: "接线端子布局图",
        title: "Figure 12",
      }),
      null as never,
      null as never,
      [],
      null as never,
    )

    const img = view.dom.querySelector("img")
    const caption = view.dom.querySelector("figcaption")

    expect(img?.getAttribute("src")).toBe(
      "tauri-asset:/Users/me/MyWiki/wiki/media/manual/img-12.png",
    )
    expect(img?.dataset.mdsrc).toBe("media/manual/img-12.png")
    expect(img?.alt).toBe("接线端子布局图")
    expect(img?.title).toBe("Figure 12")
    expect(caption?.textContent).toBe("接线端子布局图")
  })

  it("updates the rendered src without losing the raw markdown source", () => {
    const view = createResolvedImageNodeView(projectPath)(
      imageNode({ src: "media/manual/img-12.png", alt: "", title: "" }),
      null as never,
      null as never,
      [],
      null as never,
    )

    expect(
      view.update?.(
        imageNode({ src: "media/manual/img-13.png", alt: "端子细节图", title: "" }),
        [],
        null as never,
      ),
    ).toBe(true)

    const img = view.dom.querySelector("img")
    const caption = view.dom.querySelector("figcaption")
    expect(img?.getAttribute("src")).toBe(
      "tauri-asset:/Users/me/MyWiki/wiki/media/manual/img-13.png",
    )
    expect(img?.dataset.mdsrc).toBe("media/manual/img-13.png")
    expect(img?.alt).toBe("端子细节图")
    expect(img?.hasAttribute("title")).toBe(false)
    expect(caption?.textContent).toBe("端子细节图")
  })

  it("does not render a caption element when the image has no alt text", () => {
    const view = createResolvedImageNodeView(projectPath)(
      imageNode({ src: "media/manual/img-12.png", alt: "", title: "" }),
      null as never,
      null as never,
      [],
      null as never,
    )

    expect(view.dom.querySelector("img")).not.toBeNull()
    expect(view.dom.querySelector("figcaption")).toBeNull()
  })

  it("renders visual-group icons without caption and with a fixed width class", () => {
    const view = createResolvedImageNodeView(projectPath)(
      imageNode({
        src: "media/manual/img-12.png",
        alt: "",
        title: VISUAL_GROUP_ICON_TITLE,
      }),
      null as never,
      null as never,
      [],
      null as never,
    )

    const img = view.dom.querySelector("img")

    expect(img?.dataset.mdsrc).toBe("media/manual/img-12.png")
    expect(img?.dataset.visualGroupIcon).toBe("true")
    expect(img?.className).toContain("w-40")
    expect(img?.hasAttribute("title")).toBe(false)
    expect(view.dom.querySelector("figcaption")).toBeNull()
  })
})
