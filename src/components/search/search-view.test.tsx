// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockSearchWiki, mockReadFile } = vi.hoisted(() => ({
  mockSearchWiki: vi.fn(),
  mockReadFile: vi.fn(async (_path: string) => "# Source"),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock("@/lib/search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/search")>("@/lib/search")
  return {
    ...actual,
    searchWiki: (...args: unknown[]) => mockSearchWiki(...args),
  }
})

vi.mock("@/commands/fs", () => ({
  readFile: (path: string) => mockReadFile(path),
}))

vi.mock("@/lib/markdown-image-resolver", () => ({
  resolveMarkdownImageSrc: (url: string) => url,
}))

vi.mock("@/lib/raw-source-resolver", () => ({
  findRawSourceForImage: vi.fn(async () => null),
  imageUrlToAbsolute: (url: string) => url,
}))

import { SearchView } from "./search-view"
import { useWikiStore } from "@/stores/wiki-store"

describe("SearchView visual groups", () => {
  beforeEach(() => {
    mockSearchWiki.mockReset()
    mockReadFile.mockClear()
    useWikiStore.setState({
      project: {
        id: "project-123",
        name: "Manual Wiki",
        path: "/project",
      },
      selectedFile: null,
      fileContent: "",
      activeView: "search",
      pendingScrollImageSrc: null,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it("shows the whole visual group when the query matches one member label", async () => {
    mockSearchWiki.mockResolvedValue([
      {
        path: "/project/wiki/sources/operator-manual.md",
        title: "Source: operator-manual.docx",
        snippet: "连接中状态说明",
        titleMatch: false,
        score: 1,
        images: [],
        visualGroups: [
          {
            title: "Device Status",
            summary: "展示设备未连接、连接中与已连接三种状态。",
            context: "设备连接状态说明",
            members: [
              { label: "未连接", url: "media/operator-manual/img-1.png" },
              { label: "连接中", url: "media/operator-manual/img-2.png" },
              { label: "已连接", url: "media/operator-manual/img-3.png" },
            ],
          },
        ],
      },
    ])

    const user = userEvent.setup()
    render(<SearchView />)

    await user.type(screen.getByRole("textbox"), "连接中{enter}")

    await waitFor(() => expect(screen.getByText("Device Status")).toBeInTheDocument())
    expect(screen.getByText("展示设备未连接、连接中与已连接三种状态。")).toBeInTheDocument()
    expect(screen.getByText("设备连接状态说明")).toBeInTheDocument()
    expect(screen.getByText("未连接")).toBeInTheDocument()
    expect(screen.getByText("连接中")).toBeInTheDocument()
    expect(screen.getByText("已连接")).toBeInTheDocument()
  })

  it("renders text-only visual-group members when their image url is blank", async () => {
    mockSearchWiki.mockResolvedValue([
      {
        path: "/project/wiki/sources/operator-manual.md",
        title: "Source: operator-manual.docx",
        snippet: "已连接状态说明",
        titleMatch: false,
        score: 1,
        images: [],
        visualGroups: [
          {
            title: "Device Status",
            summary: "展示带空图标单元格的状态组。",
            context: "设备连接状态说明",
            members: [
              { label: "未连接", url: "media/operator-manual/img-1.png" },
              { label: "已连接", url: "" },
            ],
          },
        ],
      },
    ])

    const user = userEvent.setup()
    const { container } = render(<SearchView />)

    await user.type(screen.getByRole("textbox"), "已连接{enter}")

    await waitFor(() => expect(screen.getByText("Device Status")).toBeInTheDocument())
    expect(screen.getByText("未连接")).toBeInTheDocument()
    expect(screen.getByText("已连接")).toBeInTheDocument()
    expect(container.querySelectorAll("img")).toHaveLength(1)
  })
})
