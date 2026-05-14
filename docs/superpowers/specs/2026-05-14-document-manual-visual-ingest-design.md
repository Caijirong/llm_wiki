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
- 运行时逻辑只读取 `projectKind`

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

### Dedupe

`small_visual` 不按“每次出现”入库，而按图像内容去重。

固定规则：

- 以 `sha256` 作为分组主键
- 同一张小视觉元素在一个文档中多次出现，只形成一个 group
- group 记录：
  - 代表图片
  - 出现次数
  - 出现位置上下文样本

这是实现逻辑，不做成配置。

### Grouping

`small_visual` group 在 caption 后再进行固定分类，第一版使用内置类别：

- `button_action`
- `status_indicator`
- `mode_marker`
- `other_visual`

分类方式由代码决定，不开放用户配置类别。

### Captioning

`regular_visual` 继续走现有 caption 链路。

`small_visual` group 走单次 caption：

- 每个 group 只 caption 一次
- caption 输入使用代表图片
- 同时拼入该 group 聚合后的前后文样本
- prompt 偏向识别：
  - 这是按钮还是状态标记
  - 它表示什么动作 / 状态 / 模式
  - 图中可见文字需尽量原样保留

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

### Buttons

- Save button icon
  Seen: 5 times
  Context: “点击保存”, “保存当前配置”

![Save button icon](media/.../img-12.png)

### Status Indicators

- Enabled status indicator
  Seen: 8 times
  Context: “当前已启用”, “设备在线”

![Enabled status indicator](media/.../img-18.png)
```

约束：

- 该区块由代码生成，格式固定
- 小视觉元素按 group 展示，不逐个重复输出
- 每个 group 至少输出一个代表图片

## Search and Retrieval

`small_visual` 的知识进入搜索，不靠图片文件本身，而靠写入 wiki markdown 的结构化文本。

效果来源：

- group caption
- group 分类名
- 代表性上下文
- 出现次数与位置锚点

由于这些内容进入了 `wiki/sources/<slug>.md`，后续 embedding 与检索会自然覆盖，不需要另开索引系统。

目标效果：

- 搜“保存按钮 / enabled / 编辑模式 / 在线状态”时可召回
- 搜具体手册动作词、状态词时也可召回
- wiki 页面中能看到分组后的视觉元素总结

## Technical Design

### Project metadata

扩展现有 `.llm-wiki/project.json` 结构。

当前文件由 [src/lib/project-identity.ts](../../../src/lib/project-identity.ts) 读写。第一版调整为：

- `ensureProjectId()` 兼容读取老格式
- 若无 `projectKind`，默认视为 `general`
- 新增一个显式写入 `projectKind` 的 helper

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

### Create-project flow

[src/components/project/create-project-dialog.tsx](../../../src/components/project/create-project-dialog.tsx) 在创建项目后：

1. 创建基础目录
2. 写入模板内容
3. 确保 `.llm-wiki/project.json` 存在
4. 写入 `projectKind`

### Extraction boundary

第一版不把“策略配置”下推为可调参数，而是下推为固定 profile 分支：

- default profile
- document-manual profile

该 profile 是代码分支，不是用户配置。

对于 `document-manual + DOCX`：

- Office 图片提取路径放宽小视觉元素的提取范围
- Rust 返回的图片元信息增加固定分类字段，避免在 TS 重复判断

建议新增元信息：

```ts
visualClass: "regular_visual" | "small_visual"
```

这不是用户可配置数据，只是提取结果的内部结构化标记。

### Ingest pipeline

在 ingest 阶段：

1. 读取当前项目 `projectKind`
2. 若不是 `document-manual`，沿用当前逻辑
3. 若是 `document-manual + DOCX`
   - 提取图片
   - 将结果拆为 `regular_visual` 与 `small_visual`
   - `small_visual` 按 `sha256` 聚合
   - 对 group 做一次 caption + 分类
   - 生成固定区块 `## UI Visual Elements`
   - 与现有 source-summary 写入逻辑合并

## Error Handling

- 小视觉元素链路失败不能中断整个 ingest
- group caption 单项失败只影响该 group
- 老项目缺失 `projectKind` 不报错，自动视为 `general`
- 模板写入 `projectKind` 失败时，项目仍可创建，但应记录告警并回退为 `general`

## Testing

需要补的测试：

- `project-identity`
  - 老 `project.json` 兼容读取
  - 新项目可写入 `projectKind`
- `templates / create project`
  - `document-manual` 模板能把 `projectKind` 落到项目元数据
- `extract / ingest`
  - `document-manual + DOCX` 会保留小视觉元素
  - 相同 `sha256` 的小视觉元素被正确去重
  - group caption 失败不影响整体 ingest
  - 输出 markdown 中生成固定的 `## UI Visual Elements` 区块
- `search`
  - 小视觉元素的 caption / 上下文文本可参与召回

## Risks

- DOCX 中某些小资源可能仍是纯装饰噪声
- 单纯按 hash 去重，无法合并“视觉上相同但像素略不同”的近似图标
- 小视觉元素分类 prompt 若过弱，`button / status / mode` 可能混淆

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
