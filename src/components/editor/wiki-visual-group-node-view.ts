import {
  parseVisualGroupBlocks,
  VISUAL_GROUP_BLOCK_FENCE_INFO,
} from "@/lib/document-manual-visual-block"
import { resolveMarkdownImageSrc } from "@/lib/markdown-image-resolver"
import type { StoredVisualGroup } from "@/lib/document-manual-visual-types"
import type { Node as ProseMirrorNode } from "@milkdown/prose/model"
import type { NodeView, NodeViewConstructor } from "@milkdown/prose/view"

function readString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function isVisualGroupCodeBlock(node: ProseMirrorNode): boolean {
  return readString(node.attrs.language) === VISUAL_GROUP_BLOCK_FENCE_INFO
}

function parseVisualGroupNode(node: ProseMirrorNode): StoredVisualGroup | null {
  if (!isVisualGroupCodeBlock(node)) return null
  const markdown = `\`\`\`${VISUAL_GROUP_BLOCK_FENCE_INFO}\n${node.textContent}\n\`\`\``
  return parseVisualGroupBlocks(markdown)[0] ?? null
}

function renderVisualGroupBlock(
  dom: HTMLElement,
  group: StoredVisualGroup,
  projectPath: string | null,
) {
  dom.replaceChildren()
  dom.className = "my-6"
  dom.dataset.visualGroupId = group.id

  const title = document.createElement("h3")
  title.className = "mb-2 text-2xl font-semibold tracking-tight"
  title.textContent = group.title
  dom.appendChild(title)

  if (group.summary) {
    const summary = document.createElement("p")
    summary.className = "mb-4 text-base leading-8"
    summary.textContent = group.summary
    dom.appendChild(summary)
  }

  const wrapper = document.createElement("div")
  wrapper.className = "overflow-x-auto rounded-lg border border-border"

  const table = document.createElement("table")
  table.className = "w-full border-collapse text-sm"

  const thead = document.createElement("thead")
  thead.className = "bg-muted"
  const headRow = document.createElement("tr")

  for (const text of ["图标", "图标描述"]) {
    const th = document.createElement("th")
    th.className = "border border-border/80 bg-muted px-4 py-3 text-left text-xl font-semibold"
    th.textContent = text
    headRow.appendChild(th)
  }

  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement("tbody")
  for (const item of group.items) {
    const row = document.createElement("tr")

    const iconCell = document.createElement("td")
    iconCell.className = "w-64 border border-border/60 px-6 py-6 align-middle"
    if (item.image) {
      const icon = document.createElement("img")
      icon.src = resolveMarkdownImageSrc(item.image, projectPath)
      icon.dataset.mdsrc = item.image
      icon.alt = ""
      icon.loading = "lazy"
      icon.className = "w-40 max-w-none rounded border border-border/40"
      iconCell.appendChild(icon)
    } else {
      const placeholder = document.createElement("div")
      placeholder.className = "h-20 w-40 rounded border border-dashed border-border/30 bg-muted/20"
      iconCell.appendChild(placeholder)
    }

    const descCell = document.createElement("td")
    descCell.className = "border border-border/60 px-6 py-6 align-top text-xl"
    descCell.textContent = item.description

    row.appendChild(iconCell)
    row.appendChild(descCell)
    tbody.appendChild(row)
  }

  table.appendChild(tbody)
  wrapper.appendChild(table)
  dom.appendChild(wrapper)
}

export function createVisualGroupAwareCodeBlockNodeView(
  projectPath: string | null,
): NodeViewConstructor {
  return (node: ProseMirrorNode) => {
    const visualGroup = parseVisualGroupNode(node)
    if (!visualGroup) {
      const dom = document.createElement("pre")
      dom.className = "my-3 overflow-x-auto rounded border border-border/40 bg-muted/30 p-3"
      const code = document.createElement("code")
      const language = readString(node.attrs.language)
      if (language) code.className = `language-${language}`
      dom.appendChild(code)

      return {
        dom,
        contentDOM: code,
        update: (updatedNode: ProseMirrorNode) => {
          if (isVisualGroupCodeBlock(updatedNode)) return false
          const updatedLanguage = readString(updatedNode.attrs.language)
          code.className = updatedLanguage ? `language-${updatedLanguage}` : ""
          return true
        },
      } satisfies NodeView
    }

    const dom = document.createElement("section")
    renderVisualGroupBlock(dom, visualGroup, projectPath)

    return {
      dom,
      update: (updatedNode: ProseMirrorNode) => {
        const updatedGroup = parseVisualGroupNode(updatedNode)
        if (!updatedGroup) return false
        renderVisualGroupBlock(dom, updatedGroup, projectPath)
        return true
      },
      ignoreMutation: () => true,
    } satisfies NodeView
  }
}
