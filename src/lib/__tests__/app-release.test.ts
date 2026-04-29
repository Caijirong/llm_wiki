import { describe, expect, it } from "vitest"
import { APP_RELEASE_REPO, APP_RELEASES_URL } from "@/lib/app-release"

describe("app release metadata", () => {
  it("uses the packaged app repository instead of the upstream remote", () => {
    expect(APP_RELEASE_REPO).toBe("Caijirong/llm_wiki")
    expect(APP_RELEASES_URL).toBe("https://github.com/Caijirong/llm_wiki/releases")
  })
})
