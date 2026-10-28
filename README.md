# 知识库自动化插件（kb-automation）

把 `F:/test/11/1.md` 里那四段任务做成一个可重复执行的 DSH 工具：`kb_automate`。

> **从 GitHub 安装（另一台电脑）**
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

| 阶段 | 对应 1.md | 做什么 |
| --- | --- | --- |
| `init` | 第一段 | 校验/创建六个中文目录（含 `03 提炼笔记/{概念,方法,案例}`）、`06 系统配置/笔记模板.md`、`06 系统配置/知识库规范.md`，并输出目录树 |
| `collect` | 第二段 | 用 `ctx.web` 检索 AI Agent / AI 价格优惠 / AI 生产案例，模型筛选 3~7 篇，写成 `status: inbox` 的收件箱笔记 |
| `process` | 第三段 | 读规范 → 原文存档到 `02 原始资料` → 拆原子笔记到 `03 提炼笔记` → 打三维标签 → 链接进 `04 主题索引` → 原笔记改 `processed` |
| `inspect` | 第四段 | 补标签/摘要、给重复笔记的合并建议、查外链、算本周新增与主题分布，写周报到 `05 我的产出` |
| `all` | — | 依次执行上面四个阶段 |
| `status` | — | 只读体检：各目录篇数、收件箱待处理清单、任务文件是否存在 |

## 工具参数

```json
{
  "stage": "init | collect | process | inspect | all | status",
  "vault": "F:/dataobs",
  "topics": ["AI Agent 最新进展"],
  "limit": 6
}
```

- `vault` 省略时取插件配置 `vault`（默认 `F:/dataobs`）。
- `topics` 只对 `collect` 生效，覆盖配置里的检索词。
- `limit` 对 `collect` 是本次最多收录篇数（1–7），对 `process` 是本次最多处理篇数。

## 配置

`cordis.patch.yml` 里的 `config`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `vault` | `F:/dataobs` | 知识库根目录；调用时可用 `vault` 参数覆盖 |
| `taskFile` | `F:/test/11/1.md` | 任务说明文件，`status` 阶段检查它是否存在 |
| `maxCollect` | `6` | collect 默认收录上限 |
| `topics` | 见 `src/collect.js` 的 `DEFAULT_TOPICS` | 检索词 |
| `linkCheckLimit` | `20` | inspect 每次最多验证多少条外链 |
| `maxAgeDays` | `2` | collect 丢弃早于 N 天的内容（按页面上的首个日期判断） |
| `fetchMode` | `auto` | `auto` 先走 `ctx.web.fetch`、被拒再直连；`web` 只走 harness；`direct` 只直连 |
| `heuristicFallback` | `false` | 设为 `true` 才允许模型失败时按规则猜着拆（默认不拆，留在收件箱） |

## 实现要点

- **模型参与判断，插件负责落地。** 选篇、摘要、拆解用 `ctx.llm`（走当前 profile 默认模型），文件命名、frontmatter 字段顺序、标签维度、去重、索引插入都由代码确定性完成，所以重复执行不会产生格式漂移。
- **宁可不动，也不乱拆。** 模型没给出合法结果时，收件箱笔记原样保留并在 `kept` 里写原因；原子笔记还要过校验（标题 ≥4 字、摘要 ≥20 字、正文 ≥60 字、不能是「价格」「发布」「待核实」这类小节名），不合格一律拒收。
- **只做加法。** 不删除、不合并、不覆盖已存在的原始存档与原子笔记；`02 原始资料` 已有同名文件时跳过并记录。
- **幂等。** 目录、模板、规范已存在时不改写；收件箱里 `status` 不是 `inbox` 的笔记不会被重复处理；已存在的原子笔记/MOC 链接会去重。
- **空文件与信息不足的笔记**按 1.md 的约束留在收件箱，并在结果的 `kept` 里注明原因。
- 文件操作直接走 Host 的 `node:fs`（目录创建、原子写入），检索走 `ctx.web`，模型走 `ctx.llm`，不额外拉依赖。

## 分发

`INSTALL.md` 是给另一台机器的安装说明；打包命令：

```bash
tar -a -c -f kb-automation-1.1.0.zip -C <父目录> kb-automation
```

解压后把 `cordis.patch.yml` 里的 `vault` / `taskFile` 改成目标机器的路径，再 `plugin_manager install_bundle`。

## 安全边界

- `inspect` 对重复笔记只输出"合并建议清单"，不删不改；外链只做 HTTP 状态检查，不抓正文判定内容是否被替换。
- 所有新增内容都写进六个目录内部，不在仓库外落文件；插件自身代码放在 `.kb-automation/`（Obsidian 不索引点开头目录）。

## 开发

```bash
node --check index.js
node test/smoke.mjs   # frontmatter 往返、命名规则、MOC 插入、目录树
```
