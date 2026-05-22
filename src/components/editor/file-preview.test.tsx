// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `tauri-asset:${path}`,
}))

import { FilePreview } from "./file-preview"
import { useWikiStore } from "@/stores/wiki-store"

describe("FilePreview", () => {
  afterEach(() => {
    cleanup()
    useWikiStore.setState({
      project: null,
      pendingScrollImageSrc: null,
    })
  })

  it("renders Windows absolute markdown image paths through the image resolver", () => {
    useWikiStore.setState({
      project: { id: "p1", name: "Manuals", path: "C:/proj" },
    })

    const { container } = render(
      <FilePreview
        filePath="C:/proj/raw/sources/manual.pdf"
        textContent="![](C:/proj/wiki/media/manual/img-1.png)"
      />,
    )

    const img = container.querySelector("img")
    expect(img).not.toBeNull()
    expect(img?.getAttribute("src")).toBe(
      "tauri-asset:C:/proj/wiki/media/manual/img-1.png",
    )
    expect(img?.dataset.mdsrc).toBe("C:/proj/wiki/media/manual/img-1.png")
  })
})
