# 知识库自动化插件（kb-automation）

**从 GitHub 安装（另一台电脑）**
>
> ```bash
> git clone https://github.com/dravelin/kb-automation.git D:/dsh-plugins/kb-automation
> ```
>
> 改 `cordis.patch.yml` 里的 `vault`（知识库路径），然后：
>
> ```json
> { "action": "install_bundle", "target": "D:/dsh-plugins/kb-automation" }
> ```
>
> 详细步骤与排错见 [INSTALL.md](INSTALL.md)。

| 阶段 | 序 | 做什么 |
| --- | --- | --- |
| `init` | 第一段 | 校验/创建六个中文目录（含 `03 提炼笔记/{概念,方法,案例}`）、`06 系统配置/笔记模板.md`、`06 系统配置/知识库规范.md`，并输出目录树 |
| `collect` | 第二段 | 用 `ctx.web` 检索 AI Agent / AI 价格优惠 / AI 生产案例，模型筛选 3~7 篇，写成 `status: inbox` 的收件箱笔记 |
| `process` | 第三段 | 读规范 → 原文存档到 `02 原始资料` → 拆原子笔记到 `03 提炼笔记` → 打三维标签 → 链接进 `04 主题索引` → 原笔记改 `processed` → **删除 `01 收件箱` 里已归档的那份副本**（拆解失败也照样归档，只缺原子笔记，周报里列入「待补拆解」） |
| `inspect` | 第四段 | 补标签/摘要、给重复笔记的合并建议、查外链、算本周新增与主题分布，写周报到 `05 我的产出` |
| `board` | — | 只返回建卡方案：每日「收集 + 提炼」与每周「巡检 + 周报」两张卡片（id/标题/描述/自包含 prompt/cron），不写任何文件 |
| `all` | — | 依次执行前四个阶段（不含 `board`） |
| `status` | — | 只读体检：各目录篇数、收件箱待处理清单 |

## 01 收件箱 与 02 原始资料

- `01 收件箱` 是「还等着提炼的原始文章」暂存区：既放插件自动收集的文章，也放你自己从网页存下来直接丢进去的 `.md`。没有 frontmatter 也行，插件会补上日期与 frontmatter。
- 文件名统一是收录日 `YYYY-MM-DD-标题.md`；文章自己的发布日期存在 frontmatter 的 `published` 字段里，不会被收录日顶掉。
- `process` 把原文搬进 `02 原始资料` 之后，就删掉 `01 收件箱` 里的那份副本（`02` 里已有同名文件时同样删）。这是**搬移，不是合并**。
- 拆解失败的笔记**也照样归档**进 `02 原始资料` 并删副本 —— 它缺的只是 `03` 里的原子笔记，`inspect` 会在周报「待补拆解」列出。收件箱只留空文件与正文 < 40 字的残篇。
- `02/03/04/05` 里的文件永不删除、永不合并。

## 工具参数

```json
{
  "stage": "init | collect | process | inspect | board | all | status | selftest",
  "vault": "F:/dataobs",
  "topics": ["AI Agent 最新进展"],
  "limit": 6
}
```

- `vault` 省略时取插件配置 `vault`（默认 `F:/dataobs`）。
- `topics` 只对 `collect` 生效，覆盖配置里的检索词。
- `limit` 对 `collect` 是本次最多收录篇数（1–7），对 `process` 是本次最多处理篇数。
- `board` 不读不写文件；返回的 `cards[].prompt` 已经带上 `vault`，可直接交给建卡会话。

## 配置

`cordis.patch.yml` 里的 `config`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `vault` | `F:/dataobs` | 知识库根目录；调用时可用 `vault` 参数覆盖 |
| `maxCollect` | `6` | collect 默认收录上限 |
| `topics` | 见 `src/collect.js` 的 `DEFAULT_TOPICS` | 检索词 |
| `linkCheckLimit` | `20` | inspect 每次最多验证多少条外链 |
| `maxAgeDays` | `2` | collect 丢弃早于 N 天的内容（按页面上的首个日期判断） |
| `fetchMode` | `auto` | `auto` 先走 `ctx.web.fetch`、被拒再直连；`web` 只走 harness；`direct` 只直连 |
| `heuristicFallback` | `false` | 设为 `true` 才允许模型失败时按规则猜着拆（默认不拆；原文照样归档，只是记入「待补拆解」） |

## board 阶段：建卡

看板插件的 cordis 服务 `taskBoard` 只暴露 `registerExtension` / `isExtensionEnabled`，没有建卡 API，所以 `kb_automate` 只能**算出卡片方案**，真正的建卡要由 DSH 会话调工具完成：

```text
kb_automate {"stage":"board","vault":"F:/dataobs"}
  → cards[0] = daily   / cron 0 8 * * *   （每日 08:00 收集 + 提炼）
  → cards[1] = weekly  / cron 0 9 * * 1   （每周一 09:00 巡检 + 周报）
```

拿到返回值后，让会话逐张建卡并挂定时：

```json
{ "title": "知识库日常：收集 + 提炼", "description": "<cards[0].description>", "prompt": "<cards[0].prompt>" }
```

```json
{ "taskId": "<上一步返回的卡片 id>", "enabled": true, "mode": "cron", "cron": "0 8 * * *", "timeZone": "Asia/Shanghai" }
```

```json
{ "title": "知识库周检：巡检 + 周报", "description": "<cards[1].description>", "prompt": "<cards[1].prompt>" }
```

```json
{ "taskId": "<上一步返回的卡片 id>", "enabled": true, "mode": "cron", "cron": "0 9 * * 1", "timeZone": "Asia/Shanghai" }
```

`task_board_create` 建卡、`task_board_schedule` 挂 cron，两条 cron 分别是 `0 8 * * *` 与 `0 9 * * 1`（时区 `Asia/Shanghai`）。`board` 阶段本身不写任何文件。

## v2 变更（1.1.0 → 2.0.0）

破坏性的语义变化，升级前先看这一节：

- **`process` 现在会删文件。** 归档成功后，`01 收件箱` 里那份副本会被删除（`02 原始资料` 已有同名文件时也删）。1.1.0 里它是整份留在收件箱只改 `status`，所以收件箱会一直堆积。
- **`01 收件箱` 的定义收窄成「待提炼暂存区」。** 不再是长期存档目录；想长期留的原文在 `02 原始资料`。同时允许直接丢入没有 frontmatter 的 `.md`，插件补日期与 frontmatter。
- **归档不再「已存在就跳过」。** 同名已存在时仍会删掉收件箱副本，避免重复堆积；`02` 里的旧文件不被覆盖。
- **新增 `board` 阶段**（枚举、参数说明、返回值契约）与对应的渲染。
- **删除边界文案重写**：旧的「永不删除、永不合并」绝对说法改为「只删除 `01 收件箱` 里已归档成功的副本」；`02/03/04/05` 仍然永不删除、永不合并。
- 版本号 `1.1.0` → `2.0.0`，`BUILD` 同步为 `kb-automation@2.0.0`。

### 2.0.1：拆解失败也归档

- **拆不出原子笔记不再卡住收件箱。** 归一化后正文 ≥ 40 字的笔记一律归档进 `02 原始资料` 并删掉 `01 收件箱` 副本，能不能拆出原子笔记是另一件事；收件箱只剩空文件、正文 < 40 字、不可读这三种。上一版「拆解失败的笔记留在收件箱」的说法到此作废。
- **模型 JSON 三管齐下。** 拆解调用的 `maxTokens` 从 3000 提到 6000；返回解析不出 JSON 时，用「只输出一个 JSON 对象、`atoms` 最多 3 条、每条 `body` 不超过 200 字」的强约束重试一次（同样 6000）；两次都失败才按上一条兜底归档。`extractJson` 另外做一次最小修复（截到已配平的最后一个 `}`、去掉尾逗号）。
- **返回值新增 `unsplit`。** `process` 返回 `unsplit: [{ file, archived, reason }]`，`processed[].unsplit` / `unsplitReason` 标出没拆出原子笔记的那几篇，`summary` 追加「未拆解 N 篇」。
- **`inspect` 周报新增「待补拆解」一节。** 扫 `02 原始资料`，列出没有任何 `03 提炼笔记` 的 `source: "[[...]]"` 引用到的原文（数量 + 前 10 个文件名），它们缺的只是原子笔记。
- 版本号 `2.0.0` → `2.0.1`，`BUILD` 同步为 `kb-automation@2.0.1`。

### 2.0.2：移除残留的任务说明文件依赖

纯清理，不改任何阶段的运行逻辑：`status` 不再检查任务说明文件（返回值里不再有对应字段，渲染里不再有「任务文件」一行），该配置项已删除，插件不再引用任何外部任务文档。

### 2.0.3：文档修正

「开发」小节里指向 `test/smoke.mjs` 的命令在仓库中并不存在，换成对全部源码做语法检查的一行命令；版本号同步到 `2.0.3`，以便按 tag 安装的机器也拿到这条修正。

## 实现要点

- **模型参与判断，插件负责落地。** 选篇、摘要、拆解用 `ctx.llm`（走当前 profile 默认模型），文件命名、frontmatter 字段顺序、标签维度、去重、索引插入都由代码确定性完成，所以重复执行不会产生格式漂移。
- **宁可不动，也不乱拆。** 模型没给出合法结果时，收件箱笔记原样保留并在 `kept` 里写原因；原子笔记还要过校验（标题 ≥4 字、摘要 ≥20 字、正文 ≥60 字、不能是「价格」「发布」「待核实」这类小节名），不合格一律拒收。
- **只删已归档的收件箱副本。** `process` 是搬移：归档成功后删掉 `01 收件箱` 里那份；`02 原始资料` 已有同名文件时同样删并记录。除此之外不删除、不合并任何文件，已存在的原始存档与原子笔记一律不覆盖。
- **幂等。** 目录、模板、规范已存在时不改写；收件箱里 `status` 不是 `inbox` 的笔记不会被重复处理；已存在的原子笔记/MOC 链接会去重。
- **空文件与正文不足 40 字的笔记**留在收件箱，并在结果的 `kept` 里注明原因。
- 文件操作直接走 Host 的 `node:fs`（目录创建、原子写入），检索走 `ctx.web`，模型走 `ctx.llm`，不额外拉依赖。

## 分发

`INSTALL.md` 是给另一台机器的安装说明；打包命令：

```bash
tar -a -c -f kb-automation-2.0.2.zip -C <父目录> kb-automation
```

解压后把 `cordis.patch.yml` 里的 `vault` 改成目标机器的路径，再 `plugin_manager install_bundle`。

## 安全边界

- `inspect` 对重复笔记只输出"合并建议清单"，不删不改；外链只做 HTTP 状态检查，不抓正文判定内容是否被替换。
- 所有新增内容都写进六个目录内部，不在仓库外落文件；插件自身代码放在 `.kb-automation/`（Obsidian 不索引点开头目录）。

## 开发

```bash
for f in index.js src/*.js; do node --check "$f" || exit 1; done
```
