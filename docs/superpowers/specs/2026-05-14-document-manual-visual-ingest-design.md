# Document-Manual Visual Ingest Design

## Summary

本设计为项目新增一种固定类型的知识库：`document-manual`。

该类型的核心目标是让“手册/操作文档中的小视觉元素”进入知识库，但不把这件事做成用户可调策略中心。项目只暴露一个稳定标识：`projectKind`。是否放开小图、如何去重、如何分组、如何写入 wiki、如何参与搜索，全部由代码中的固定逻辑决定。

第一版只实现 `DOCX` 导入链路。配置与字段命名保持通用，不引入任何 `word*` 或 `docx*` 风格的项目级配置字段。

## Problem

当前多模态摄取链路默认过滤掉小于 `100x100` 的图片。这对论文、报告类项目是合理的成本保护，但对手册型知识库不成立：

- 手册中大量有价值的信息正是小图标、小按钮、小状态标记
- 这些视觉元素通常表达“状态 / 模式 / 操作入口 / 交互反馈”
- 过滤后，知识库无法按这些视觉语义搜索召回
- 即便图片文件落盘，未进入 caption / markdown / embedding 的内容仍然无法形成可检索知识

## Goals

- 新增一种项目类型 `document-manual`
- 该项目类型下，手册类资料导入时自动纳入小视觉元素
- 第一版仅支持 `DOCX`
- 小视觉元素需要：
  - 可进入知识库
  - 可搜索召回
  - 可在 wiki 中分组展示
- 项目行为由 `projectKind` 决定，不提供设置页或运行时开关

## Non-Goals

- 第一版不实现 `PDF / PPTX / HTML / 图片目录` 的小视觉元素摄取
- 不为用户提供尺寸阈值、分组方式、去重方式等配置项
- 不把这套逻辑推广到所有项目类型
- 不做模板切换后的策略迁移

## Decision

### 1. 项目类型是唯一外部输入

项目只增加一个新的稳定字段：

```json
{
  "id": "uuid",
  "createdAt": 1710000000000,
  "projectKind": "document-manual"
}
```

该字段写入现有的 `.llm-wiki/project.json`，不新增单独的 ingest profile 文件。

约束：

- `projectKind` 一旦由模板创建，不在 UI 中提供修改入口
- 老项目缺失该字段时，按 `general` 处理
- 运行时的项目分支只读取 `projectKind`
- 但这不等于“忽略所有全局设置”：现有全局设置若与 `document-manual` 固定行为冲突，必须在实现中显式定义优先级

### 2. 模板只负责写入项目类型

新增模板 `Document / Manual`。

模板职责：

- 写入 `schema.md`
- 写入 `purpose.md`
- 写入或补齐 `.llm-wiki/project.json` 中的 `projectKind: "document-manual"`

模板不暴露任何“小图尺寸 / 去重 / 分组 / 展示”设置。这些都属于代码策略，不属于模板配置面。

### 3. 第一版仅对 DOCX 启用固定逻辑

当且仅当：

- `projectKind === "document-manual"`
- 导入源类型为 `DOCX`

系统启用“小视觉元素分组摄取”。

其他情况：

- 非 `document-manual` 项目保持当前行为
- `document-manual` 项目的 `PDF / PPTX` 在第一版仍保持当前行为

### 4. `document-manual` 对多模态总开关的优先级

当前系统已有 `multimodalConfig.enabled` 总开关。第一版明确：

- `multimodalConfig.enabled` 的优先级高于 `projectKind`
- 该总开关仍然是“图片是否进入 wiki 知识”的硬门
- `document-manual` 只在该总开关开启后，决定 DOCX 小视觉元素如何进入知识库
- 当总开关关闭时：
  - 不执行小视觉元素知识注入
  - 不写入 `wiki/sources/<slug>.md` 的视觉知识区块
  - 不参与搜索与 embedding
  - 图片文件仍可按现有逻辑落到 `wiki/media/` 供原始预览使用

这保证当前产品对全局开关的语义保持不变：全局 > 项目。

## Behavioral Design

### Visual classes

第一版将视觉元素分为两类：

- `regular_visual`
  - 普通图片、截图、流程图、结构图、较大的界面片段
- `small_visual`
  - 小图标、小按钮图、状态标记、模式标记等

这里的判断规则是固定代码逻辑，不是用户配置。第一版建议内置如下启发式：

- `regular_visual`
  - 延续现有“大图”逻辑
- `small_visual`
  - 在 `document-manual + DOCX` 路径下放宽提取
  - 提取后由固定阈值再归类为小视觉元素
  - 阈值属于实现常量，不进入项目配置或设置页

为避免歧义，第一版固定采用以下规则：

- 当前“大图阈值”明确为现有逻辑的 `100x100`
- 小于 `12px` 任一边的资源直接忽略
- `width >= 100 && height >= 100` 的资源进入 `regular_visual`
- 其余资源中，满足 `min(width, height) >= 12 && max(width, height) < 192` 的资源进入 `small_visual`
- 未命中以上规则的资源忽略

这保证第一版的行为稳定，同时不给用户暴露调参面。

### Semantic grouping

`small_visual` 的第一层组织方式不是按图片内容去重，而是按“文档相邻语义”建立 `semantic group`。

这里的核心问题不是“这两张图是否像素一样”，而是“这几张图是否共同表达同一个概念组”。例如：

- `状态1: 未连接`
- `状态2: 连接中`
- `状态3: 已连接`

这三张图应属于同一个“设备状态”语义组，而不是三个彼此独立的单图节点。

第一版固定采用如下分组思路：

1. 先按 `document.xml` 顺序构建视觉锚点 occurrence 序列
2. 只对 `small_visual` 做组判断
3. 按结构邻近与文本邻近建立组

固定判定规则：

- 同一标题区块下的小视觉元素优先视为同一候选语义域
- 同一表格中的相邻行 / 相邻列小视觉元素优先归为一组
- 同一列表中的连续小视觉元素优先归为一组
- 同一标题下、连续短段落中的小视觉元素可归为一组
- 被长段正文隔开的元素默认断组

组的目标不是“合并相同图片”，而是显式表达“这些图片共同构成一组状态 / 一组按钮 / 一组模式”。

### Dedupe

去重发生在 `semantic group` 之后，只做组内去重，不承担分组职责。

固定规则：

- 同组内以 `sha256 + 规范化标签文本` 作为去重键
- 同组内完全重复的同一图标只保留一个 member，并累计出现次数
- 不跨组去重

这是实现逻辑，不做成配置。

### Captioning

`regular_visual` 继续走现有 caption 链路。

`small_visual` 不再只做“代表图 caption”，而是区分组级与成员级语义：

- 组级：
  - 生成 group title / group summary
- 成员级：
  - 为每个 member 生成短标签
  - 优先使用该图片邻近的短文本
  - 邻近文本不足时，再回退到单图 caption

prompt 偏向识别：

- 该组共同表达的主题是什么
- 每个成员分别表示什么状态 / 动作 / 模式
- 图中可见文字需尽量原样保留
- 若相邻文本明确给出“状态1/状态2/状态3”之类标签，应优先采用该标签

如果 caption 失败：

- 不中断 ingest
- 该 group 仍可进入 wiki 展示
- 搜索文本退化为位置上下文聚合结果

## Wiki Output

### Existing behavior retained

普通图片继续沿用当前 `Embedded Images` 思路。

### New grouped section for small visuals

对于 `document-manual + DOCX`，在 `wiki/sources/<slug>.md` 中新增固定区块：

```md
## UI Visual Elements

### Device Status

Context: “设备连接状态说明”

- 状态1：未连接
![状态1：未连接](media/.../img-12.png)

- 状态2：连接中
![状态2：连接中](media/.../img-13.png)

- 状态3：已连接
![状态3：已连接](media/.../img-14.png)
```

约束：

- 该区块由代码生成，格式固定
- 小视觉元素按 `semantic group` 展示
- 组内按 member 展示，不丢掉不同状态 / 不同按钮成员
- 组内重复成员只在去重后保留一次
- 该区块不是对现有 `## Embedded Images` 的轻量改写，而是新的 group-aware 写入契约

## Search and Retrieval

`small_visual` 的知识进入搜索，不靠图片文件本身，而靠写入 wiki markdown 的结构化文本。

效果来源：

- group title / group summary
- member 标签文本
- 组级上下文
- 组内成员图片

由于这些内容进入了 `wiki/sources/<slug>.md`，后续 embedding 与检索会自然覆盖，不需要另开索引系统。

目标效果：

- 搜“保存按钮 / 编辑模式 / 在线状态”时可召回对应组
- 搜“状态2 / 连接中 / 已连接”时也能命中同一状态组
- 搜中某个成员时，结果中仍能看到其同组的其他成员
- wiki 页面中能看到分组后的视觉元素总结

### Search UI contract

第一版不仅要求“页面文本可被召回”，还要求搜索展示层保留 group 语义：

- 当 query 命中某个 group title / group summary / member label 时
- Search UI 需要展示整个 group，而不是继续把图片按 URL 扁平化
- “命中一个成员时看到同组其他成员”是本特性的显式范围内要求

这意味着搜索展示需要新的 group-aware 数据流，不能继续只消费扁平 `ImageRef[]`

## Technical Design

### Project metadata

扩展现有 `.llm-wiki/project.json` 结构。

当前文件由 [src/lib/project-identity.ts](../../../src/lib/project-identity.ts) 读写。第一版调整为：

- `ensureProjectId()` 兼容读取老格式
- 若无 `projectKind`，默认视为 `general`
- 新增一个显式写入 `projectKind` 的 helper
- 设置 `projectKind` 时不得因解析失败而重建 `id`
- 设置 `projectKind` 必须走单一的 read-modify-write helper，保证不会破坏现有 `id`

建议结构：

```ts
interface ProjectIdentity {
  id: string
  createdAt: number
  projectKind?: "general" | "research" | "reading" | "personal" | "business" | "document-manual"
}
```

### Template model

[src/lib/templates.ts](../../../src/lib/templates.ts) 的 `WikiTemplate` 增加 `projectKind` 字段，但不增加任何 ingest 策略字段。

模板只表达“这是什么项目”：

- `general`
- `research`
- `reading`
- `personal`
- `business`
- `document-manual`

本特性依赖 `projectKind`，不依赖模板写入的 `schema.md / purpose.md` 文本内容来驱动运行时行为。

### Create-project flow

[src/components/project/create-project-dialog.tsx](../../../src/components/project/create-project-dialog.tsx) 在创建项目后：

1. 创建基础目录
2. 写入模板内容
3. 确保 `.llm-wiki/project.json` 存在
4. 写入 `projectKind`

### Extraction boundary

第一版不把“策略配置”下推为可调参数，而是下推为固定代码分支：

- default profile
- document-manual profile

该 profile 是代码分支，不是用户配置。

对于 `document-manual + DOCX`：

- Office 图片提取路径放宽小视觉元素的提取范围
- Rust 不再只返回“平铺图片列表”，而是先构建文档顺序的视觉 occurrence
- 默认 `SavedImage[]` 合同不足以表达本特性；第一版需要一个 `document-manual + DOCX` 专用返回合同
- JS 侧不能仅靠现有 `extract_and_save_office_images_cmd(sourcePath, destDir, relTo)` 达成该能力

建议新增元信息：

```ts
visualClass: "regular_visual" | "small_visual"
```

这不是用户可配置数据，只是提取结果的内部结构化标记。

并新增一层内部 occurrence 结构：

```ts
type DocxVisualOccurrence = {
  mediaPath: string
  docOrder: number
  sectionTitle: string | null
  containerKind: "paragraph" | "list_item" | "table_cell"
  tableId?: number
  rowIndex?: number
  colIndex?: number
  localTextBefore: string
  localTextAfter: string
  contextBefore: string
  contextAfter: string
}
```

该结构用于建立 `semantic group`，不是对外配置。

第一版实现约束：

- occurrence 必须来自 `word/document.xml` 主文档锚点顺序
- 不是所有 `word/media/*` 文件都能进入这条链路
- 没有主文档锚点的 media 资源不参与 `semantic group`

第一版显式排除：

- `svg / emf / wmf` 等当前未栅格化的 Office 资源
- 仅出现在 header/footer/theme/unused asset 中、未出现在 `word/document.xml` 主文档锚点序列中的资源

这些排除项属于第一版已知边界，不视为 bug

### Command/API insertion point

第一版需要明确新的插入点，而不是隐含复用旧命令：

- 非 `document-manual` 或非 `DOCX`：
  - 继续走现有 `extract_and_save_office_images_cmd`
- `document-manual + DOCX`：
  - 走新的专用 Rust 命令
  - 返回 occurrence-based 结果，而不是平铺 `SavedImage[]`

是否命名为：

- `extract_and_save_docx_manual_visuals_cmd`

或等价名称，可在 implementation plan 再定；但“新增专用命令”本身在本 spec 中已明确。

### Ingest pipeline

在 ingest 阶段，必须统一收敛到共享 helper，而不是分别在不同入口各写一套分支。

第一版覆盖的入口至少包括：

- `autoIngest()`
- `startIngest() / executeIngestWrites()` 路径

在共享 helper 中：

1. 读取当前项目 `projectKind`
2. 若不是 `document-manual`，沿用当前逻辑
3. 若是 `document-manual + DOCX`
   - 调用 DOCX manual 专用提取命令
   - 将结果拆为 `regular_visual` 与 `small_visual`
   - 按 `document.xml` 顺序构建 `DocxVisualOccurrence` 序列
   - 基于结构邻近与文本邻近建立 `semantic group`
   - 对每个 group 生成组级标题与摘要
   - 对每个 member 生成标签文本
   - 组内再做 `sha256 + label` 去重
   - 生成固定区块 `## UI Visual Elements`
   - 通过新的 group-aware writer 写入 source summary

第一版不复用当前只能处理平铺 `SavedImage[]` 的 `injectImagesIntoSourceSummary()` 作为唯一 writer；需要新的 group-aware 写入契约。

## Error Handling

- 小视觉元素链路失败不能中断整个 ingest
- group caption 单项失败只影响该 group
- 老项目缺失 `projectKind` 不报错，自动视为 `general`
- 模板写入 `projectKind` 失败时，项目仍可创建，但不得破坏已有 `project id`

## Testing

需要补的测试：

- `project-identity`
  - 老 `project.json` 兼容读取
  - 新项目可写入 `projectKind`
- `templates / create project`
  - `document-manual` 模板能把 `projectKind` 落到项目元数据
- `extract / ingest`
  - `document-manual + DOCX` 会保留小视觉元素
  - 同一状态序列 / 按钮序列被正确建成 `semantic group`
  - 组内相同 `sha256 + label` 的小视觉元素被正确去重
  - group caption 失败不影响整体 ingest
  - 输出 markdown 中生成固定的 `## UI Visual Elements` 区块
- `search`
  - 小视觉元素的组标题、成员标签、上下文文本可参与召回
  - 命中单个成员时，Search UI 能展示同组其他成员

## Risks

- DOCX 中某些小资源可能仍是纯装饰噪声
- 仅依赖邻近结构，仍可能把不相关小图误并到一组
- 仅依赖组内去重，无法合并“视觉上相同但像素略不同”的近似成员
- 第一版不支持未栅格化的 Office 向量图标资源
- Search UI 需要配套改造，否则只能做到“页面可召回”而不能做到“组可展示”

这些风险第一版接受。优先保证：

- 固定行为
- 可检索
- 可展示
- 不污染普通项目

## Rollout

第一版上线顺序：

1. 新增 `document-manual` 模板与 `projectKind`
2. 打通 `projectKind` 到 ingest 的读取链路
3. 仅在 `document-manual + DOCX` 中启用小视觉元素分组摄取
4. 生成固定 wiki 分组区块
5. 补测试

后续扩展：

- 在不修改项目元数据结构的前提下，扩展到 `PDF / PPTX`
- 继续沿用 `document-manual` 这一项目类型
