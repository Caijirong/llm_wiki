---
name: using-llm-wiki
description: "Use for local LLM Wiki lookups, grounded answers/drafts, prior knowledge reuse, internal standards, and wiki file imports. Triggers: 知识库, wiki, 之前, 规范, 说明, 导入."
---

# Using LLM Wiki

Use this skill for knowledge-base workflows backed by an `llm-wiki` MCP server. The user does not need to mention `llm-wiki`; if the request is about existing knowledge, wiki content, saved materials, or importing sources, use this skill and route the work through `llm-wiki`.

## Immediate requirement

For query, writing, explanation, or context-completion intent, the next substantive action after loading this skill is a knowledge-base lookup. Do not answer from memory first.

- If `llm_wiki_get_context` is exposed, call it first with the user's original query.
- If `llm_wiki_get_context` is unavailable but `llm_wiki_search` is exposed, call `llm_wiki_search`.
- If a full-sentence query returns no pages but the topic is clear, retry once with the concise core topic phrase.
- If no first-class MCP tool is exposed, inspect the registered `llm-wiki` MCP server or use the HTTP MCP fallback before answering.
- If the lookup cannot be performed, report the exact missing tool, endpoint, or connection failure.
- Never produce generic filler, boilerplate, or "common sense" answers when wiki evidence could exist but was not checked.
- Do not stop after reading the skill or noticing that first-class MCP tools are absent. Continue until `llm-wiki` was queried or a concrete registration/reachability failure was observed.

## What this skill covers

- Query an `llm-wiki` knowledge base
- Answer questions grounded in knowledge base content
- Generate explanations, docs, proposals, guides, summaries, and drafts grounded in wiki content
- Reuse prior project knowledge, standards, terminology, and historical solutions
- Import files into the knowledge base through the upload/ingest flow
- Route knowledge-base-oriented tasks through the `llm-wiki` MCP tools

## What this skill does NOT cover

- Direct page editing inside the wiki through MCP
- Generic web search as a substitute for knowledge base retrieval
- Pretending the knowledge base is unavailable before checking exposed MCP tools or the configured MCP server

## Trigger rules

Activate this skill when the user intent matches any of these:

1. **Knowledge query intent**
   - “这个是什么？”
   - “这个怎么用？”
   - “A 和 B 有什么区别？”
   - “帮我解释一下 X”
   - “X 是什么意思？”
   - “根据知识库…”
   - “查一下知识库里有没有…”
   - “wiki 里有没有…”
   - “已有资料里有没有…”
   - “根据项目记忆…”
   - “基于之前的知识…”
   - “根据历史知识…”
   - “基于现有知识库内容总结…”
   - “什么是 X（要求按已有资料回答）”

2. **Internal standards intent**
   - “我们公司这个怎么做？”
   - “项目里标准是什么？”
   - “内部规范怎么要求？”
   - “这个模块/系统/流程应该按什么规则处理？”

3. **Experience reuse intent**
   - “之前有没有类似方案？”
   - “有没有现成文档？”
   - “历史上怎么做的？”
   - “找一下已有材料里有没有参考”
   - “复用之前的方案/表达/结构”

4. **Document generation intent**
   - “帮我写个说明”
   - “写一份设计文档 / 使用指南 / 方案 / 汇报 / 提案”
   - “基于现有资料整理成文档”
   - “把这些知识组织成可交付文本”

5. **Context completion intent**
   - Conversation mentions a likely project-specific term, module name, system name, product, client, policy, internal process, or domain concept
   - The user asks a short follow-up like “这个呢？”, “它怎么处理？”, “这里怎么写？” and the referent may exist in wiki
   - A generic answer would likely miss local terminology, prior decisions, or documented constraints

6. **Knowledge base import intent**
   - “把这个文件导入知识库”
   - “上传到知识库”
   - “写入知识库” when the real operation is file import
   - “把资料加入 wiki”
   - “把资料沉淀下来”
   - “导入这些文档”

7. **Usage/process intent**
   - “怎么查知识库”
   - “怎么把资料入库”
   - “agent 怎么基于 wiki 回答”
   - “如何让已有资料参与回答”

## Decision rules

- Use this skill aggressively for normal conversation when the topic is likely local, historical, internal, project-specific, or domain-specific.
- Do not activate only because a user asks a purely general question with no local/domain term and no need for internal context.
- If the user asks for a grounded answer from the knowledge base, use `llm-wiki` first.
- If the user asks for writing help and the requested document could use wiki knowledge, query first, then draft from the evidence.
- If the user asks to add material to the knowledge base, treat that as **file upload/import** only.
- If the task needs current KB evidence, do not answer from memory or generic web results before checking `llm-wiki`.
- For imports, call `llm_wiki_get_upload_guide` first and follow the returned upload contract.
- If the upload service is stopped, unavailable, or unauthorized, report that runtime state directly.
- If no first-class MCP tool exists, inspect the configured MCP server through the host client or use the HTTP MCP fallback.

## Grounding standard

- Start from wiki facts, terminology, page titles, and prior structures; then synthesize.
- Prefer concrete local details over generic industry framing.
- If wiki evidence is thin, say so and separate "wiki says" from "general inference".
- Do not invent internal standards, project history, page names, or source coverage.
- For document drafts, reuse relevant wiki concepts and source titles instead of writing empty templates.

## Image Usage Policy

- Treat `knowledgeImages` returned by `llm_wiki_get_context` as optional supporting evidence, not as a requirement to always render images.
- Use an image only when it materially improves the answer. Do not append every related image by default.
- When an image is used, place it at the single most relevant point in the answer so the response reads as one coherent flow instead of text followed by an image dump.
- Do not repeat the same image more than once in a single answer.
- Prefer the most relevant matching image first. Additional images are allowed only when each one adds distinct value and is placed intentionally.
- If the client supports Markdown image rendering, inline the image with the title and the exact `url` returned by `MCP`.
- If the client does not support image rendering, cite the image title and URL in text instead.
- Do not invent image URLs, rewrite them into guessed local paths, or claim an image was shown if it was only cited.

## Capability detection

Use the best available access path in this order:

1. First-class MCP tools exposed in the current agent session, such as `llm_wiki_get_context`, `llm_wiki_search`, or `llm_wiki_get_upload_guide`.
2. The agent host's MCP registry or diagnostics. In OpenClaw, `openclaw mcp list` and `openclaw mcp show llm-wiki` are required checks when first-class tools are absent.
3. A configured MCP HTTP endpoint. Use the Streamable HTTP flow only when direct MCP tools are unavailable.

In OpenClaw, treat `openclaw mcp show llm-wiki` as the source of truth for:
- whether `llm-wiki` is registered
- the MCP endpoint URL
- required authentication headers that must be forwarded to MCP HTTP requests

Do not require OpenClaw commands in non-OpenClaw clients.

**OpenClaw operating rule:** if first-class `llm_wiki_*` tools are absent but `llm-wiki` is registered in `openclaw mcp show llm-wiki`, continue through MCP over HTTP. Do not declare the KB unavailable at that point.

## Query workflow

For query, explanation, document-generation, and context-completion tasks, read `references/query-flow.md` and follow it.

**Hard gate:** after this skill triggers for wiki grounding, do not produce a user-facing grounded answer until the query flow reaches a terminal state defined in `references/query-flow.md`.

Default answering format:

1. Short grounded summary
2. Related references / entries / page titles
3. If confidence is limited, say the KB evidence is limited

## Import workflow

For file-import tasks, read `references/import-flow.md` and follow it.

Key boundary:

- Writing is supported through **file upload + ingest**
- Writing is **not** direct wiki page mutation over MCP
- Import starts with `llm_wiki_get_upload_guide`, then `/uploads`, then ingest queue tracking

## Failure handling

- If no `llm-wiki` MCP tools or endpoint are available, say so directly
- If initialization fails, report MCP connection failure directly
- If tools are unavailable, surface that exact limitation
- If ingest is still processing, do not poll aggressively; tell the user it is queued/processing and use the recommended poll interval
- In OpenClaw, do not treat the absence of first-class tools as a failure by itself; only report KB access failure after registration or MCP HTTP access reached a concrete blocking error
- If retrieved pages clearly state that they are placeholder analyses based only on filenames, document titles, or partial context, explicitly say the KB evidence is limited and do not present the result as full-text source grounding

## Output standard

### For queries

Return:
- A direct answer in plain language
- Supporting references or entries from the KB
- Clear wording when evidence is partial

### For document drafts

Return:
- A usable draft, not an empty template
- Wiki-grounded terminology, assumptions, constraints, and examples
- A short "依据" section with related wiki entries when useful
- Clear separation between wiki-backed content and inferred filler

### For imports

Return:
- Whether the upload request was sent
- The ingest task status if available
- Whether the task is pending / processing / done / failed

## Client-specific note

When OpenClaw has an MCP server registered as `llm-wiki`, use that server for knowledge-base-oriented tasks. Do not bypass it with unrelated wiki, document, or web-search flows unless `llm-wiki` cannot do the job.

In OpenClaw, `llm-wiki` may be present as an HTTP MCP server even when no first-class `llm_wiki_*` tools are exposed in the session. In that case:
- inspect registration with `openclaw mcp show llm-wiki`
- reuse the configured auth headers from that output
- perform `initialize -> notifications/initialized -> tools/list -> tools/call`
- expect Streamable HTTP / SSE-style responses and parse JSON from `data:` lines
- reuse `Mcp-Session-Id` returned by `initialize`

Read `references/query-flow.md` for the exact OpenClaw query sequence.
