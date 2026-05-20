# Query Flow

Use this flow when the user wants answers, explanations, document drafts, or context completion based on existing `llm-wiki` knowledge base content.

## Terminal states

Treat the query workflow as complete only when one of these states is reached:

1. **Query success** — `llm-wiki` was actually queried and returned results or an empty result set.
2. **Concrete failure** — a specific blocking failure was observed and can be reported precisely, such as missing MCP registration, unreachable endpoint, initialize failure, session creation failure, `tools/list` failure, or `tools/call` failure.

Before reaching one of these states, do not claim the KB is unavailable and do not answer from a fallback source as though KB grounding had been completed.

## 1. Confirm server registration

Prefer already exposed MCP tools. If tools such as `llm_wiki_search`, `llm_wiki_read_page`, or `llm_wiki_list_projects` are available in the current agent session, use them directly.

If no first-class MCP tools are exposed, inspect the host client's MCP configuration. For OpenClaw, required checks are:

```bash
openclaw mcp list
openclaw mcp show llm-wiki
```

In OpenClaw, `openclaw mcp show llm-wiki` is the authoritative source for:
- the registered MCP endpoint URL
- the server transport type
- headers that must be forwarded to HTTP MCP requests

For other clients, use their equivalent MCP diagnostics. Do not require OpenClaw commands outside OpenClaw.

**Guardrail:** absence of first-class MCP tools is not a stopping condition. It means you must continue into MCP fallback.

## 2. Establish MCP session

When no first-class MCP tool is exposed, use the registered MCP HTTP endpoint.

Minimum sequence:

1. `initialize`
2. `notifications/initialized`
3. `tools/list`
4. `tools/call`

Important:
- Send `Accept: application/json, text/event-stream`
- Send `Content-Type: application/json`
- Reuse authentication that the client already uses for the MCP endpoint
- Extract `Mcp-Session-Id` from the `initialize` response headers and send it on later requests
- Expect Streamable HTTP / SSE-style responses and parse JSON from `data:` lines
- Treat `notifications/initialized` returning `202` as normal in OpenClaw-compatible environments
- Treat the flow as incomplete until `tools/call` succeeds or a concrete MCP failure is observed

## 3. Choose the right llm-wiki tool

Prefer tools by intent, not by memorized assumptions.

### Use `llm_wiki_search` when:
- the user is exploring whether the KB contains something
- you need a relevance-ranked hit list first
- the user asks broad questions like “什么是 X”, “这个怎么处理”, or “知识库里有没有…”
- you need to discover both knowledge pages and likely source pages

### Use `llm_wiki_read_page` when:
- you already know the page path or id
- search results point to a specific page that should be read directly
- you need the full source-page sections such as `## Embedded Images` or `## UI Visual Elements`
- you need to paginate through a long source page with `start_offset` / `max_chars`

### Use `llm_wiki_list_projects` when:
- project scope is unclear
- the user asks about available knowledge-base projects

## 4. Query strategy

Recommended order for broad question answering:

1. `llm_wiki_search` with the user query
2. inspect hit titles, snippets, and paths
3. `llm_wiki_read_page` for the strongest matching page
4. if the answer needs visual evidence, inspect the best matching source page as well
5. synthesize the answer following the skill's image-usage policy

Recommended order for “知识库里有没有 X” style exploration:

1. `llm_wiki_search` with the user query
2. inspect hit titles, snippets, and paths
3. if needed, `llm_wiki_read_page` for the strongest matching page
4. answer whether the KB contains relevant material

Recommended order for “有没有对应图片/图标/截图/界面状态” style lookup:

1. `llm_wiki_search` with the user query, icon label, figure caption, state name, or UI section term
2. if the strongest hit is a concept/entity page, read it first and extract its `sources:` clues
3. treat `sources:` as a source-location hint; if it contains raw filenames rather than wiki paths, locate the source page by source filename, title, or source slug
4. continue to the corresponding source page; do not stop at the concept/entity page
5. inspect `page.resources`
6. inspect `## Embedded Images` for regular figures/screenshots/diagrams
7. inspect `llm-wiki-visual-group` blocks inside `## UI Visual Elements` for icon groups, small state visuals, and table-driven UI indicators
8. if needed, run a second-pass search with explicit visual keywords such as `21区 图标`, `设备故障状态 显示`, `heading-path: 21区`, `image: media/`, or `visual-group`
9. if the source page is long, keep paging through it until the target visual section is found or the relevant section is exhausted

Explicit operating chain for visual lookups:

1. `search(主题词)`
2. read the matching concept/entity page
3. extract `sources:`
4. resolve `sources:` into the corresponding source page
5. open the source page
6. check `page.resources` / `## Embedded Images` / `llm-wiki-visual-group`
7. if needed, continue with `start_offset` windows until the target block is reached
8. only then synthesize the answer

If the tool returns a warning about fallback retrieval, say so only when it materially affects the answer.

If the query returns zero relevant results, that still counts as a completed KB query. Report the empty/limited evidence directly.

If the best matching pages explicitly say they are based only on filenames, document titles, or placeholder analysis, state that the KB evidence is limited and avoid presenting the result as if the full source text had been verified.

Visual grounding rules:

- extracted document media is canonically attached to the source page, not to the concept/entity page that may summarize the knowledge
- if a concept/entity page explains the topic but contains no visual evidence, continue to the relevant source page instead of concluding that no image exists
- when a concept/entity page matches, default to following its `sources:` trail to the corresponding source page before making any negative judgment about visual evidence
- `page.resources` is the canonical mapping from raw resource references in the returned `content` window to directly accessible HTTP URLs
- raw `media/...` values from markdown images or visual-group `image:` fields are not directly usable URLs; match them against `page.resources[].rawRef` and use `page.resources[].url`
- `## UI Visual Elements` may contain structured visual groups whose `image:` fields must be resolved through `page.resources`
- some `UI Visual Elements` rows may intentionally have blank `image:` values; in that case the textual row meaning is still evidence, but there may be no retrievable icon binary for that row
- if the page is long, pagination is mandatory for visual retrieval whenever the relevant heading, `heading-path`, `title`, or `table-context` has not been reached yet
- concept/entity pages are best for semantic summaries such as priority, linkage, and status meaning; source pages are best for visual evidence such as icon rows, colors, screenshots, and retrievable image URLs
- if the concept name and the visual-group label do not match exactly in granularity, call that out explicitly as a naming mismatch rather than pretending they are identical

## 5. OpenClaw MCP over HTTP reference pattern

Use this pattern when OpenClaw has `llm-wiki` registered but the current session does not expose first-class `llm_wiki_*` tools:

1. Run `openclaw mcp show llm-wiki`
2. Copy the MCP endpoint URL exactly
3. Forward the configured auth headers exactly
4. POST `initialize`
5. Read `Mcp-Session-Id` from response headers
6. POST `notifications/initialized` with that session id
7. POST `tools/list` with that session id
8. POST `tools/call` with that session id
9. Parse JSON payloads from SSE `data:` lines

Do not stop after `tools/list`. A grounded answer requires a successful `tools/call` or a concrete failure.

## 6. Response format

Default response structure:

1. **结论/总结** — answer the user directly
2. **依据条目** — list related page titles or paths
3. **补充说明** — only if evidence is weak, ambiguous, partial, or empty

Example structure:

- `subagents`：定义是……
- 相关条目：`entities/subagents.md`, `sources/sub-agents.md`, `index.md`
- 补充：当前项目中该术语主要出现在 Claude Code 语境下

## 7. Guardrails

- Do not claim the KB is unavailable before checking registration and MCP reachability
- Do not answer “based on the KB” unless `llm-wiki` was actually queried
- Do not replace KB retrieval with generic web search when the user explicitly asked for KB grounding
- Do not invent page titles, paths, or KB evidence
- Do not assume visual assets live on concept/entity pages just because that is where the knowledge explanation was found
- Do not say “no icon / no image / no diagram” based only on the concept/entity page. You must inspect the corresponding source page and its visual sections first.
- Before returning a negative visual answer, verify all three checkpoints:
  1. relevant concept/entity page
  2. corresponding source page
  3. source-page visual groups or image lists
- If evidence is limited, say exactly that
- If first-class tools are absent, continue into MCP fallback rather than stopping
- If the workflow is not yet in a terminal state, say retrieval is still in progress or report the concrete blocking step; do not silently substitute a non-KB answer
- If results come from placeholder pages or filename-only analysis, clearly label that limitation in the final answer
