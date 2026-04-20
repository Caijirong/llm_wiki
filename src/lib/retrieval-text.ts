const SNIPPET_CONTEXT = 80
const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
])

export function tokenizeQuery(query: string): string[] {
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .filter((token) => token.length > 1)
    .filter((token) => !STOP_WORDS.has(token))

  const tokens: string[] = []

  for (const token of rawTokens) {
    const hasCjk = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)

    if (hasCjk && token.length > 2) {
      const chars = [...token]
      for (let window = 2; window <= Math.min(chars.length, 4); window += 1) {
        for (let i = 0; i <= chars.length - window; i += 1) {
          const ngram = chars.slice(i, i + window).join("")
          if (!STOP_WORDS.has(ngram)) {
            tokens.push(ngram)
          }
        }
      }

      for (const ch of chars) {
        if (!STOP_WORDS.has(ch)) {
          tokens.push(ch)
        }
      }
      continue
    }

    tokens.push(token)
  }

  return [...new Set(tokens)]
}

export function tokenMatchScore(text: string, tokens: readonly string[]): number {
  const lower = text.toLowerCase()
  let score = 0

  for (const token of tokens) {
    if (lower.includes(token)) score += 1
  }

  return score
}

export function extractTitle(content: string, fileName: string): string {
  const frontmatterMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
  if (frontmatterMatch) return frontmatterMatch[1].trim()

  const headingMatch = content.match(/^#\s+(.+)$/m)
  if (headingMatch) return headingMatch[1].trim()

  return fileName.replace(/\.md$/, "").replace(/-/g, " ")
}

export function buildSnippet(content: string, query: string): string {
  const lower = content.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const index = lower.indexOf(lowerQuery)

  if (index === -1) {
    return content.slice(0, SNIPPET_CONTEXT * 2).replace(/\n/g, " ")
  }

  const start = Math.max(0, index - SNIPPET_CONTEXT)
  const end = Math.min(content.length, index + query.length + SNIPPET_CONTEXT)
  let snippet = content.slice(start, end).replace(/\n/g, " ")
  if (start > 0) snippet = `...${snippet}`
  if (end < content.length) snippet = `${snippet}...`
  return snippet
}
