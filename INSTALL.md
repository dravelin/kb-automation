# 安装说明（另一台电脑）

这个目录是一个 DSH Host 插件包（bundle），提供工具 `kb_automate`，按 `1.md` 的四段任务跑知识库流水线。

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

## 2. 改配置

打开 `cordis.patch.yml`，把两个路径改成这台机器上的实际位置：

```yaml
- insert:
    - id: kb-automation
      name: '@local/kb-automation'
      config:
        vault: D:/我的知识库        # 知识库根目录，不存在会自动创建六个中文目录
        taskFile: D:/任务/1.md      # 只用于 status 阶段做存在性检查，可以留空
        maxCollect: 6
```

`vault` 也可以不写死在配置里：调用工具时传 `vault` 参数即可覆盖（适合一次装好、多个库切换）。

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

能返回目录篇数和 `构建：kb-automation@1.1.0` 就说明工具已注册。

再跑一次模型自检，确认模型和检索都通：

```json
{ "stage": "selftest" }
```

## 5. 跑任务

按顺序，或一次跑完：

| 目的 | 调用 |
| --- | --- |
| 建库/补齐结构 | `{"stage":"init"}` |
| 收集今天的内容 | `{"stage":"collect","limit":5}` |
| 整理收件箱 | `{"stage":"process"}` |
| 巡检 + 周报 | `{"stage":"inspect"}` |
| 全流程 | `{"stage":"all"}` |

首次建议 `status → init → collect → process → inspect` 逐段跑，能看到每段的明细；`all` 适合定时任务。

## 6. 常见问题

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `'pnpm' 不是内部或外部命令` | 机器上没有 pnpm | `npm install -g pnpm@11` |
| `ERR_PNPM_UNEXPECTED_STORE` | pnpm 大版本与已有 store 不一致 | 按错误里提示的 store 版本装对应大版本，例如 `npm i -g pnpm@11` |
| `ERR_PNPM_GIT_FETCH_FAILED ... SEC_E_NO_CREDENTIALS` | Git 的 schannel 后端取不到凭证（profile 里有 github 依赖时会触发） | `git config --global http.sslBackend openssl` |
| `URL hostname "xxx" resolves to a non-public IP address` | 本机 DNS 把公网域名解析到保留地址（Clash fake-ip 之类），被 harness 的抓取策略拒绝 | 插件默认会自动改用直连抓取并在结果里告警；想强制走某一种，设 `fetchMode: "web"` 或 `"direct"` |
| 收件箱笔记没被处理 | `status` 不是 `inbox`，或正文不足 40 字，或没有可用模型 | 看结果里的 `kept` 字段，它写明每条未处理的原因 |
| 收集阶段 0 篇 | 检索结果都过期/重复，或抓不到正文 | 看 `warnings` 与 `rejected`，1.md 允许「少收几篇并说明原因」 |

## 7. 行为边界

- 不删除、不合并、不覆盖：`02 原始资料` 已有同名存档就跳过；重复笔记只输出合并建议清单。
- 幂等：重复执行不会重复建目录、重复拆笔记、重复插索引链接。
- 模型拆不出的笔记会留在收件箱并注明原因，插件不会猜着拆（除非把 `heuristicFallback` 设为 `true`）。
- 插件代码放在知识库外或点开头的目录里最省心，Obsidian 不会把它当笔记索引。
