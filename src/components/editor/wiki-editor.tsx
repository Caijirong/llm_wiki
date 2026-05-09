import { useMemo, useRef } from "react"
import { Editor, rootCtx, defaultValueCtx, nodeViewCtx } from "@milkdown/kit/core"
import { commonmark } from "@milkdown/kit/preset/commonmark"
import { gfm } from "@milkdown/kit/preset/gfm"
import { history } from "@milkdown/kit/plugin/history"
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener"
import { math } from "@milkdown/plugin-math"
import { nord } from "@milkdown/theme-nord"
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react"
import type { NodeViewConstructor } from "@milkdown/prose/view"
import "@milkdown/theme-nord/style.css"
import "katex/dist/katex.min.css"
import { createResolvedImageNodeView } from "./wiki-image-node-view"
import { useWikiStore } from "@/stores/wiki-store"

interface WikiEditorInnerProps {
  content: string
  onSave: (markdown: string) => void
  projectPath: string | null
}

function WikiEditorInner({ content, onSave, projectPath }: WikiEditorInnerProps) {
  // Milkdown fires `markdownUpdated` once on initial parse before any
  // user interaction. That one emit must not be forwarded as a save,
  // otherwise just opening a file can overwrite its content with
  // Milkdown's normalized-but-equivalent re-emit (or, worse, with a
  // placeholder string that came back from a failed read).
  const initialEmitConsumedRef = useRef(false)

  useEditor(
    (root) =>
      Editor.make()
        .config(nord)
        .config((ctx) => {
          ctx.set(rootCtx, root)
          ctx.set(defaultValueCtx, content)
          const imageNodeView: [string, NodeViewConstructor] = [
            "image",
            createResolvedImageNodeView(projectPath),
          ]
          ctx.update(nodeViewCtx, (views) => [
            ...views.filter(([name]) => name !== "image"),
            imageNodeView,
          ])
          initialEmitConsumedRef.current = false
          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
            if (!initialEmitConsumedRef.current) {
              initialEmitConsumedRef.current = true
              return
            }
            onSave(markdown)
          })
        })
        .use(commonmark)
        .use(gfm)
        .use(math)
        .use(history)
        .use(listener),
    [content, projectPath],
  )

  return <Milkdown />
}

interface WikiEditorProps {
  content: string
  onSave: (markdown: string) => void
}

function wrapBareMathBlocks(text: string): string {
  return text.replace(
    /(?<!\$\$\s*)(\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\})(?!\s*\$\$)/g,
    (_match, block: string) => `$$\n${block}\n$$`,
  )
}

export function WikiEditor({ content, onSave }: WikiEditorProps) {
  const projectPath = useWikiStore((s) => s.project?.path ?? null)
  const processedContent = useMemo(() => wrapBareMathBlocks(content), [content])

  return (
    <MilkdownProvider>
      <div className="prose prose-invert min-w-0 max-w-none overflow-hidden p-6">
        <WikiEditorInner
          content={processedContent}
          onSave={onSave}
          projectPath={projectPath}
        />
      </div>
    </MilkdownProvider>
  )
}
