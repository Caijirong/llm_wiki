import { resolveMarkdownImageSrc } from "@/lib/markdown-image-resolver"
import { VISUAL_GROUP_ICON_TITLE } from "@/lib/document-manual-visual-block"
import type { Node as ProseMirrorNode } from "@milkdown/prose/model"
import type { NodeView, NodeViewConstructor } from "@milkdown/prose/view"

function readString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function applyImageAttrs(
  img: HTMLImageElement,
  node: ProseMirrorNode,
  projectPath: string | null,
) {
  const rawSrc = readString(node.attrs.src)
  const alt = readString(node.attrs.alt)
  const title = readString(node.attrs.title)
  const isVisualGroupIcon = title === VISUAL_GROUP_ICON_TITLE

  img.src = resolveMarkdownImageSrc(rawSrc, projectPath)
  img.dataset.mdsrc = rawSrc
  img.alt = alt
  img.dataset.visualGroupIcon = isVisualGroupIcon ? "true" : "false"
  img.className = isVisualGroupIcon
    ? "w-40 max-w-none rounded border border-border/40"
    : "max-w-full rounded border border-border/40"
  if (title && !isVisualGroupIcon) img.title = title
  else img.removeAttribute("title")
}

function syncCaption(figure: HTMLElement, node: ProseMirrorNode) {
  const title = readString(node.attrs.title)
  const alt = readString(node.attrs.alt).trim()
  let caption = figure.querySelector("figcaption")

  if (!alt || title === VISUAL_GROUP_ICON_TITLE) {
    caption?.remove()
    return
  }

  if (!caption) {
    caption = document.createElement("figcaption")
    caption.className = "mt-1 text-xs leading-snug text-muted-foreground"
    figure.appendChild(caption)
  }
  caption.textContent = alt
}

export function createResolvedImageNodeView(
  projectPath: string | null,
): NodeViewConstructor {
  return (node: ProseMirrorNode) => {
    const dom = document.createElement("figure")
    dom.className = "my-3 inline-block max-w-full"
    const img = document.createElement("img")
    img.loading = "lazy"
    dom.appendChild(img)
    applyImageAttrs(img, node, projectPath)
    syncCaption(dom, node)

    return {
      dom,
      update: (updatedNode: ProseMirrorNode) => {
        applyImageAttrs(img, updatedNode, projectPath)
        syncCaption(dom, updatedNode)
        return true
      },
    } satisfies NodeView
  }
}
