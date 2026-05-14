import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const { mockListDirectory } = vi.hoisted(() => ({
  mockListDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: (path: string) => mockListDirectory(path),
}))

import { findRawSourceForImage, imageUrlToAbsolute } from "./raw-source-resolver"

const PROJECT = "/Users/me/My Wiki"
const RAW_TREE: FileNode[] = [
  {
    name: "sources",
    path: `${PROJECT}/raw/sources`,
    is_dir: true,
    children: [
      {
        name: "source with spaces.docx",
        path: `${PROJECT}/raw/sources/source with spaces.docx`,
        is_dir: false,
      },
      {
        name: "nested",
        path: `${PROJECT}/raw/sources/nested`,
        is_dir: true,
        children: [
          {
            name: "diagram folder.pdf",
            path: `${PROJECT}/raw/sources/nested/diagram folder.pdf`,
            is_dir: false,
          },
        ],
      },
    ],
  },
]

beforeEach(() => {
  mockListDirectory.mockReset()
  mockListDirectory.mockResolvedValue(RAW_TREE)
})

describe("findRawSourceForImage", () => {
  it("matches encoded wiki-relative image URLs back to the raw source stem", async () => {
    await expect(
      findRawSourceForImage("media/source%20with%20spaces/img-1.png", PROJECT),
    ).resolves.toBe(`${PROJECT}/raw/sources/source with spaces.docx`)
  })

  it("matches encoded absolute image URLs back to the raw source stem", async () => {
    await expect(
      findRawSourceForImage(
        "/Users/me/My%20Wiki/wiki/media/diagram%20folder/img-2.png",
        PROJECT,
      ),
    ).resolves.toBe(`${PROJECT}/raw/sources/nested/diagram folder.pdf`)
  })
})

describe("imageUrlToAbsolute", () => {
  it("promotes a wiki-relative URL to the encoded absolute form emitted by raw previews", () => {
    expect(
      imageUrlToAbsolute("media/source with spaces/img-1.png", PROJECT),
    ).toBe("/Users/me/My%20Wiki/wiki/media/source%20with%20spaces/img-1.png")
  })

  it("keeps an already-encoded absolute URL stable", () => {
    expect(
      imageUrlToAbsolute(
        "/Users/me/My%20Wiki/wiki/media/source%20with%20spaces/img-1.png",
        PROJECT,
      ),
    ).toBe("/Users/me/My%20Wiki/wiki/media/source%20with%20spaces/img-1.png")
  })
})
