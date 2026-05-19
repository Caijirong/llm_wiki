# MCP Incremental Answer Read Design

## Summary

本设计只调整知识回答的最后一步，不调整现有检索主链。

现有 `searchWiki -> 全库 markdown 搜索 -> chunk 向量召回 -> RRF 融合` 路径保持不变。系统仍然先做一次自动检索，拿到按优先级排序的候选页列表。变化点在于：不再通过 `llm_wiki_get_context` 这类预裁剪、预拼包的接口把 page 内容一次性塞给回答模型，而是让 agent 在拿到搜索结果后，按搜索结果优先级逐步调用 `llm_wiki_read_page` 读取 wiki。

第一阶段优先调整 MCP 链路，用最小改动验证这一模式可行。内部 Chat 暂不改动，后续再切到同一套 `search + read_page` 工具语义。

## Problem

当前问题不在索引或召回范围，而在“把检索结果交给回答模型”的这一步：

- `llm_wiki_get_context` 会主动裁剪页数和单页内容
- 长页采用页前缀截断，而不是让模型按需继续读取
- 模型无法基于已有候选自行决定先读哪一页、是否继续读下一页、是否继续翻当前页
- 对大 wiki 或长页面，回答质量受限于预打包策略，而不是检索本身

因此，本次改造目标不是替换检索，而是移除回答阶段的预裁剪与预拼包。

## Goals

- 保留现有检索主链与排序逻辑
- 系统仍然先自动执行一次 `llm_wiki_search`
- agent 基于搜索结果自行决定下一步 `llm_wiki_read_page` 的读取顺序
- `llm_wiki_read_page` 默认返回整页内容，不再默认裁剪
- `llm_wiki_read_page` 支持显式分页续读，以便 agent 在发现内容过大时主动分段读取
- MCP 工具面收敛为回答阶段最小闭环，不再保留预打包上下文接口

## Non-Goals

- 不修改 `searchWiki` 的召回逻辑
- 不引入新的读取工具名
- 不引入 `segments`、`window` 等新的外部工具概念
- 不引入服务端默认读取上限
- 不为 MCP 维护 retrieval session
- 第一阶段不改内部 Chat 的执行路径

## Decision

### 1. 保留现有搜索主链

`llm_wiki_search` 继续复用当前的搜索与排序逻辑，负责：

- 全库候选发现
- title / content 命中计算
- 向量召回融合
- 结果排序
- 返回可供 agent 决策的标题、路径、摘要线索

本设计不改变该链路的输入、排序原则或召回来源。

### 2. 删除 `llm_wiki_get_context`

`llm_wiki_get_context` 不再保留兼容，也不再作为推荐路径。

原因：

- 它的核心价值是“预先拼一个紧凑 answering bundle”
- 这与本设计的方向直接冲突
- 继续保留会让 agent 面前同时存在两条回答路径，增加歧义

MCP 回答阶段收敛为两步：

1. `llm_wiki_search`
2. `llm_wiki_read_page`

### 3. 修改现有 `llm_wiki_read_page`，不新增工具

不新增 `read_segments` 或 `read_window` 等工具。

`llm_wiki_read_page` 仍然是唯一的页面读取工具，只扩展其读取能力，使其既能整页读取，也能在调用方主动要求时分页续读。

这保证工具面稳定，且与用户心智一致：

- 搜索负责查“读哪一页”
- 读页负责拿“这一页的内容”
- 页太长时，仍然是“继续读这页”，而不是切换到另一个新工具

### 4. 默认整页返回，不设置默认裁剪与服务端保护上限

`llm_wiki_read_page` 的默认行为必须是：

- 不传分页参数时，返回整篇内容

不做以下行为：

- 不设置默认 `max_chars`
- 不设置服务端保护性硬上限
- 不再像当前实现那样默认截断到固定字符数

如果调用方发现内容过大，由调用方自行在后续请求中传入分页参数进行分段读取。

### 5. MCP 无状态；后续 Chat 自维护 session

MCP 本阶段只提供无状态工具，不维护 retrieval session。

后续内部 Chat 接到这条链路时，可在应用内部维护自己的 retrieval session，例如：

- 首次自动 search 结果
- 已读页面
- 已读偏移
- 当前轮已暴露证据

但这不是本阶段 MCP 设计的一部分。

## Tool Contract

### `llm_wiki_search`

职责不变。它负责返回排序后的候选结果，足以让 agent 决定下一步读取哪个页面。

当前返回结构应继续包含：

- `project_id`
- `query`
- `warning`
- `results[]`

每个 `result` 应继续包含：

- `title`
- `relative_path`
- `score`
- `snippet`
- `title_match`

这些字段已经足以支持下一步读取：

- `relative_path` 可直接作为 `llm_wiki_read_page.path_or_id`
- `snippet` 用于判断该页是否值得优先读取
- `score` 与返回顺序可作为优先级信号

### `llm_wiki_read_page`

将现有接口扩展为：

```ts
llm_wiki_read_page({
  path_or_id: string,
  project_id?: string,
  start_offset?: number,
  max_chars?: number
})
```

返回：

```ts
{
  project_id: string,
  page: {
    exists: boolean,
    title: string,
    relative_path: string,
    total_chars: number,
    start_offset: number,
    end_offset: number,
    content: string,
    has_more_before: boolean,
    has_more_after: boolean,
    next_start_offset: number | null
  }
}
```

语义定义：

- 不传 `start_offset`、不传 `max_chars`
  - 返回整篇内容
- 传 `start_offset`、不传 `max_chars`
  - 从指定位置读取到页尾
- 不传 `start_offset`、传 `max_chars`
  - 从页首读取指定长度
- 同时传 `start_offset` 和 `max_chars`
  - 从指定位置读取指定长度

辅助字段定义：

- `total_chars`
  - 页面完整字符数
- `start_offset`
  - 本次返回内容起始偏移
- `end_offset`
  - 本次返回内容结束偏移
- `has_more_before`
  - 起始前是否仍有未读内容
- `has_more_after`
  - 结束后是否仍有未读内容
- `next_start_offset`
  - 若 `has_more_after === true`，给出建议续读偏移；否则为 `null`

## Behavioral Flow

MCP 回答阶段的推荐调用链：

1. 系统先自动执行 `llm_wiki_search(query)`
2. agent 查看搜索结果顺序、标题和摘要
3. agent 优先读取排序靠前的页：
   - `llm_wiki_read_page({ path_or_id: "<relative_path>" })`
4. 若当前页过长且仍需继续：
   - `llm_wiki_read_page({ path_or_id: "<relative_path>", start_offset: next_start_offset, max_chars: ... })`
5. 若当前页证据不足：
   - 读取下一个搜索结果对应页面
6. agent 自行决定何时停止读取并组织最终回答

关键点：

- 搜索只发生一次，除非 agent 主动再次发起新搜索
- 服务端不再替 agent 决定“该读哪几页”“每页该裁多少”
- 读取顺序完全由 agent 根据搜索结果优先级自行决定

## Implementation Notes

### Rust MCP 层

需要修改：

- `ReadPageRequest`
- `McpPage`
- `McpReadPageResponse`
- `EmbeddedMcpTools::llm_wiki_read_page`
- `read_wiki_page` 或其调用方式

实现上要点：

- 不再在 `llm_wiki_read_page` 中对 `content` 做默认固定长度截断
- 读取后根据 `start_offset` / `max_chars` 计算返回窗口
- 保留现有 `path_or_id` 解析能力，相对路径或 page id 都可读取

### 前端桥接层

当前 `mcp-retrieval-bridge` 和 `buildChatRetrievalContext` 主要服务于 `llm_wiki_search` / `llm_wiki_get_context` 的渲染器检索桥。

本阶段：

- `llm_wiki_search` 继续保留现有桥接方式
- `llm_wiki_get_context` 删除
- `llm_wiki_read_page` 走 Rust 侧直接读取路径，不依赖渲染器 context bundle

## Testing

需要新增或修改的测试重点：

### Rust MCP 测试

- `llm_wiki_read_page` 不传分页参数时返回整页
- `llm_wiki_read_page` 传 `max_chars` 时返回页首指定长度
- `llm_wiki_read_page` 传 `start_offset + max_chars` 时返回指定窗口
- `llm_wiki_read_page` 传 `start_offset` 不传 `max_chars` 时返回从该位置到页尾
- `next_start_offset`、`has_more_before`、`has_more_after` 的边界行为正确

### MCP Search 测试

- 确认 `llm_wiki_search` 的 `relative_path` 可直接用于后续 `llm_wiki_read_page`
- 确认结果顺序稳定，agent 可按顺序做下一步读取

### 回归测试

- 删除 `llm_wiki_get_context` 后，MCP tool surface 与说明文案同步更新
- 不影响现有 `llm_wiki_search` 行为

## Rollout

第一阶段只验证 MCP 可行性：

- 删除 `llm_wiki_get_context`
- 增强 `llm_wiki_read_page`
- 保持 `llm_wiki_search`

验证通过后，第二阶段再调整内部 Chat：

- 仍先自动 search 一次
- 但不再用预裁剪上下文回答
- 改为内部维护 session，并驱动同一套 `search + read_page` 语义

## Risks

- 默认整页返回会使超长页面响应显著变大
- 某些 agent 可能在没有自我约束时一次性读取过多页面
- 删除 `llm_wiki_get_context` 后，依赖该工具的外部调用方需要同步迁移

这些风险是本设计接受的显式 trade-off，因为目标正是把“是否分段读取”的决策从服务端移交给 agent。
