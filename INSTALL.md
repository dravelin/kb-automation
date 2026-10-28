# 安装说明（另一台电脑）

这个目录是一个 DSH Host 插件包（bundle），提供工具 `kb_automate`，按 init / collect / process / inspect 四个阶段跑知识库流水线；v2 另带一个 `board` 阶段，产出每日/每周定时任务卡片的建卡方案。

## 0. 前置条件

- 已安装 DSH，并且有一个能用的 profile（`dsh web` 能起来）。
- 该 profile 的 `plugin_manager` 可用（它靠 `pnpm` 安装 bundle，所以机器上要有 pnpm）。
- 模型：`llm` 与 `agentDefaultModel` 服务在该 profile 里是激活的（插件会用当前默认模型做筛选和摘要）。

## 1. 解压

解压到任意固定目录，例如：

```
D:\dsh-plugins\kb-automation
```

目录里应该有 `package.json`、`cordis.patch.yml`、`index.js`、`src\`。这个路径后面会一直被引用，装完后不要移动或删除。

## 2. 配置工作地址（先由 setup 确认）

装好之后，**第一件事是让会话跑一次 setup**，由它把默认工作地址呈给你确认：

```json
{ "stage": "setup" }
```

返回里 `configured:false` 时，`needsInput.fields` 给出四个待确认字段与默认值：

| 字段 | 含义 | 默认值来源 |
| --- | --- | --- |
| `vault` | 默认工作地址（知识库根目录，必填，必须是绝对路径） | `cordis.patch.yml` 的 `vault` |
| `collect.topics` | 每日收集的检索主题（数组） | 当前生效的主题列表 |
| `collect.limit` | 每轮最多收录几篇（1–7） | 当前生效值 |
| `collect.maxAgeDays` | 只收最近几天的内容（≥ 1） | 当前生效值 |

确认后把这些值带上再调一次，配置就落盘了：

```json
{ "stage": "setup", "vault": "D:/我的知识库", "limit": 5 }
```

之后重跑 `{"stage":"setup"}` 只会回显当前配置，不再询问。

### 2.1 配置文件在哪、怎么改

```text
C:\Users\<你>\.dsh\kb-automation\config.json
```

这个文件在**插件包外面**，插件升级（整包替换）不会丢；也可以直接手改，下一次调用就生效（每次调用都重读，不缓存、不用重启）。

```json
{
  "version": 1,
  "vault": "D:/我的知识库",
  "collect": { "topics": ["AI Agent 最新进展", "AI 落地 案例"], "limit": 6, "maxAgeDays": 2 },
  "updatedAt": "2026-10-28T12:00:00.000Z"
}
```

取值优先级：**调用参数 > 配置文件 > 插件 config（`cordis.patch.yml`）> 内置默认**。所以 `cordis.patch.yml` 里的 `vault` 只是首次 setup 的默认值与兜底值，想临时换个库直接传参数即可：

```json
{ "stage": "status", "vault": "E:/另一个库" }
```

环境变量 `KB_CONFIG_HOME` 只是给测试用的（把配置目录重定向到临时目录），正常使用不要设置。

## 3. 安装

在 DSH 里执行（工具名就是插件管理器）：

```json
{ "action": "install_bundle", "target": "D:\\dsh-plugins\\kb-automation" }
```

返回里 `"application": "applied"` 才算生效。若返回 `restart-required`，重启一次 DSH。

## 4. 验证

```json
{ "stage": "status" }
```

能返回目录篇数和 `构建：kb-automation@2.1.0` 就说明工具已注册。第一次还没配置过时，先跑 `{"stage":"setup"}` 确认工作地址（见第 2 节）。

再跑一次模型自检，确认模型和检索都通：

```json
{ "stage": "selftest" }
```

## 5. 跑任务

按顺序，或一次跑完：

| 目的 | 调用 |
| --- | --- |
| 首次确认/改配置 | `{"stage":"setup"}`（带 `vault`/`topics`/`limit`/`maxAgeDays` 即为写入） |
| 建库/补齐结构 | `{"stage":"init"}` |
| 收集今天的内容 | `{"stage":"collect","limit":5}`（时效可用 `maxAgeDays` 覆盖） |
| 整理收件箱 | `{"stage":"process"}` |
| 巡检 + 周报 | `{"stage":"inspect"}` |
| 全流程 | `{"stage":"all"}` |
| 出建卡方案 | `{"stage":"board"}` |

首次建议 `status → init → collect → process → inspect` 逐段跑，能看到每段的明细；`all` 适合定时任务。

### 5.1 `process` 会搬走收件箱里的原文

- `01 收件箱` 是「待提炼暂存区」：插件收集的文章和你从网页存下来直接丢进去的 `.md` 都放这里，没有 frontmatter 也行，插件会补日期与 frontmatter。
- 原文归档进 `02 原始资料` 之后，`01 收件箱` 里那份副本会被删除（`02` 已有同名文件时同样删）；拆解失败的留在收件箱等人工处理。
- 结果是**搬移**而不是合并：`02/03/04/05` 里的文件永不删除、永不合并。

### 5.2 建看板卡片（每日 / 每周定时）

看板插件没有建卡 API，`kb_automate` 只负责给出方案，建卡要由会话调工具：

1. 取方案：`{"stage":"board"}`，返回 `cards[]`（`daily` 与 `weekly`，各含 title / description / prompt / schedule）。
2. 建卡：`task_board_create`，把 `cards[0]` 的 `title` / `description` / `prompt` 原样传进去，拿回 `taskId`。
3. 挂定时：`task_board_schedule`，参数 `cron` 用方案里的值。

两条 cron：

| 卡片 | cron | 含义 |
| --- | --- | --- |
| `daily` | `0 8 * * *` | 每天 08:00 收集 + 提炼 |
| `weekly` | `0 9 * * 1` | 每周一 09:00 巡检 + 周报 |

```json
{ "taskId": "<task_board_create 返回的 id>", "enabled": true, "mode": "cron", "cron": "0 8 * * *", "timeZone": "Asia/Shanghai" }
```

```json
{ "taskId": "<task_board_create 返回的 id>", "enabled": true, "mode": "cron", "cron": "0 9 * * 1", "timeZone": "Asia/Shanghai" }
```

`board` 阶段本身不写任何文件，重复取方案不会产生副作用。

## 6. 常见问题

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `'pnpm' 不是内部或外部命令` | 机器上没有 pnpm | `npm install -g pnpm@11` |
| `ERR_PNPM_UNEXPECTED_STORE` | pnpm 大版本与已有 store 不一致 | 按错误里提示的 store 版本装对应大版本，例如 `npm i -g pnpm@11` |
| `ERR_PNPM_GIT_FETCH_FAILED ... SEC_E_NO_CREDENTIALS` | Git 的 schannel 后端取不到凭证（profile 里有 github 依赖时会触发） | `git config --global http.sslBackend openssl` |
| `URL hostname "xxx" resolves to a non-public IP address` | 本机 DNS 把公网域名解析到保留地址（Clash fake-ip 之类），被 harness 的抓取策略拒绝 | 插件默认会自动改用直连抓取并在结果里告警；想强制走某一种，设 `fetchMode: "web"` 或 `"direct"` |
| 收件箱笔记没被处理 | `status` 不是 `inbox`，或正文不足 40 字，或没有可用模型 | 看结果里的 `kept` 字段，它写明每条未处理的原因 |
| 收集阶段 0 篇 | 检索结果都过期/重复，或抓不到正文 | 看 `warnings` 与 `rejected`，少收几篇时结果里会说明原因 |

## 7. v2 变更（1.1.0 → 2.1.0）

### 2.1.0：配置搬出插件包

- 工作地址与收集配置写进 `~/.dsh/kb-automation/config.json`（插件包外面，升级不丢），由新增的 `setup` 阶段首次确认。
- 取值优先级统一为：调用参数 > 配置文件 > 插件 config > 内置默认；`cordis.patch.yml` 的 `vault` 退为默认值与兜底。
- 手改配置文件立即生效（每次调用都重读）；写盘是原子的。
- 新参数 `maxAgeDays`；`vault` 必须是绝对路径，否则报错「工作地址必须是绝对路径」。

### 2.0.0

- `process` 现在会在归档成功后**删除** `01 收件箱` 里的副本（旧版只改 `status` 留在收件箱）。
- `01 收件箱` 收窄为「待提炼暂存区」，并接受没有 frontmatter 的裸 `.md`。
- 新增 `board` 阶段（建卡方案，不写文件）。
- 版本号与 `BUILD` 升到 `2.0.0`。

## 8. 行为边界

- 只删已归档的收件箱副本：`process` 归档成功后删掉 `01 收件箱` 里那份（`02` 已有同名存档时同样删）。`02/03/04/05` 永不删除、永不合并；重复笔记只输出合并建议清单。
- 幂等：重复执行不会重复建目录、重复拆笔记、重复插索引链接。
- 模型拆不出的笔记会留在收件箱并注明原因，插件不会猜着拆（除非把 `heuristicFallback` 设为 `true`）。
- 插件代码放在知识库外或点开头的目录里最省心，Obsidian 不会把它当笔记索引。
