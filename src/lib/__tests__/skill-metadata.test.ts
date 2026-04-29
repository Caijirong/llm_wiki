import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

function readSkillDescription(skillPath: string): string {
  const content = readFileSync(skillPath, "utf-8")
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1]
  expect(frontmatter).toBeDefined()

  const description = frontmatter?.match(/^description:\s*"([\s\S]*?)"$/m)?.[1]
  expect(description).toBeDefined()
  return description ?? ""
}

describe("using-llm-wiki skill metadata", () => {
  it("keeps the preloaded skill description compact enough for context budgets", () => {
    const skillPath = path.resolve(process.cwd(), "skills/using-llm-wiki/SKILL.md")
    const description = readSkillDescription(skillPath)

    expect([...description].length).toBeLessThanOrEqual(180)
  })
})
