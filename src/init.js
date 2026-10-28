import path from 'node:path'
import { ensureDir, exists, readText, writeText } from './util.js'
import { FOLDERS, NOTE_KINDS, REQUIRED_DIRS, SPEC_PATH, TEMPLATE_PATH, Vault } from './vault.js'

export const TEMPLATE_CONTENT = `---
title: {{title}}
type: raw | note | moc
source: ""
author: ""
created: {{date:YYYY-MM-DD}}
tags: []
status: inbox
---

## 摘要

## 正文 / 要点

## 相关笔记

## 待办 / 延伸问题
`

export function specContent(vaultRoot) {
  return `# 知识库规范

本文件是个人知识库的权威规范。新建笔记、整理素材、拆解概念时一律以本文件为准。

## 1. 仓库根目录

\`\`\`
${vaultRoot.replace(/\\/g, '/')}
\`\`\`

所有目录、笔记与附件都放在这个根目录下，不要在根目录之外散落文件。

## 2. 目录分工

| 目录 | 存放什么 | 判断标准 |
| --- | --- | --- |
| \`01 收件箱\` | 所有新内容的临时落脚点 | 刚剪藏、刚记下、还没判断价值的东西一律先进这里 |
| \`02 原始资料\` | 剪藏的网页、PDF、字幕的原文存档 | 保持原文不动，只补 frontmatter，不改写、不删减 |
| \`03 提炼笔记\` | 原子化概念笔记的总目录 | 一条笔记只讲一件事，必须用自己的话重写 |
| \`03 提炼笔记/概念\` | 概念、术语、定义 | 「X 是什么」 |
| \`03 提炼笔记/方法\` | 方法、流程、步骤、框架 | 「怎么做 X」 |
| \`03 提炼笔记/案例\` | 案例、实例、复盘 | 「X 是怎么发生的」 |
| \`04 主题索引\` | 主题地图（MOC），知识库的导航入口 | 一个主题一篇，只放链接与线索，不写正文 |
| \`05 我的产出\` | 文章草稿、周报、课程 | 已成形或半成形的对外产出 |
| \`06 系统配置\` | 模板、规范、Agent 任务说明 | 系统文件，不写业务笔记 |

**原始资料与提炼笔记必须分开**：\`02 原始资料\` 存原文，\`03 提炼笔记\` 存自己的理解。两者是两套东西，不要混在一篇里。

## 3. 笔记模板规范

模板文件：\`${TEMPLATE_PATH.replace(/\\/g, '/')}\`

每条笔记的 frontmatter 必须包含以下 7 个字段，顺序不变：

| 字段 | 含义 | 取值 |
| --- | --- | --- |
| \`title\` | 标题 | 与文件名中「标题」部分保持一致 |
| \`type\` | 笔记类型 | \`raw\`（原始资料）、\`note\`（提炼笔记）、\`moc\`（主题索引） |
| \`source\` | 原始链接 | 原始资料的 URL 或出处；提炼笔记指向它来源的那份原始资料 |
| \`author\` | 作者 | 原文作者；自己的笔记填自己 |
| \`created\` | 创建日期 | \`YYYY-MM-DD\` |
| \`tags\` | 标签 | 数组，写法见第 4 节 |
| \`status\` | 处理状态 | \`inbox\` → \`processed\` → \`archived\` |

> 字段名一律用英文键名，取值中文化。字段不得增删、不得改顺序；允许在 \`status\` 之后追加来源自带字段。

正文固定四个小节，可以留空但不要删除：

\`\`\`
## 摘要
## 正文 / 要点
## 相关笔记
## 待办 / 延伸问题
\`\`\`

\`## 摘要\` 写 100 字以内中文摘要，末尾另起一行给出关键词：\`关键词：A、B、C\`。

## 4. 标签维度

| 维度 | 前缀 | 用途 | 示例 |
| --- | --- | --- | --- |
| 主题 | \`#主题/\` | 这篇笔记讲的是哪个领域 | \`#主题/知识管理\`、\`#主题/AI-Agent\` |
| 类型 | \`#类型/\` | 这是一篇什么形态的内容 | \`#类型/概念\`、\`#类型/方法论\`、\`#类型/案例\`、\`#类型/工具\`、\`#类型/观点\`、\`#类型/索引\` |
| 状态 | \`#状态/\` | 这篇笔记处在我处理的哪个阶段 | \`#状态/待消化\`、\`#状态/已归档\` |

规则：

- 一篇笔记至少一个主题标签；类型与状态标签各一个。
- 写进 frontmatter 的 \`tags\` 时不带 \`#\`，例如 \`- 主题/知识管理\`；写进正文时才带 \`#\`。
- 可以扩展新值，但必须沿用「维度/值」格式，不要新增平级的一级标签。

## 5. 命名规则

新笔记一律采用 \`YYYY-MM-DD-标题.md\`：

- \`YYYY-MM-DD\` 取该笔记的创建日期。
- 日期与标题之间用连字符 \`-\` 连接；标题内部不要再用空格或其他分隔符。
- 标题部分与 frontmatter 的 \`title\` 字段保持一致。
- 文件名中不得出现 \`\\ / : * ? " < > |\` 这些字符。
- 例外：\`06 系统配置\` 下的模板与规范文件（\`笔记模板.md\`、\`知识库规范.md\`）不套用日期前缀。

## 6. 处理流程

\`\`\`
新内容 → 01 收件箱 → 处理 → 02 原始资料（存原文）
                        → 03 提炼笔记（拆成概念/方法/案例）
                        → 04 主题索引（积累够了建 MOC）
\`\`\`

1. **落箱**：任何新内容先放进 \`01 收件箱\`，\`status: inbox\`，不做判断。
2. **处理**：定期清空收件箱，逐条判断价值。
3. **归档原文**：原始内容存入 \`02 原始资料\`，补全 frontmatter，\`status: processed\`，原文保持原样。
4. **拆出笔记**：从原文提炼可复用的知识点，每点写成一则原子化笔记，放进 \`03 提炼笔记\` 对应的 \`${NOTE_KINDS.join('\` / \`')}\`，\`source\` 指回原文。
5. **建索引**：某个主题的笔记积累到一定数量后，在 \`04 主题索引\` 建一篇 MOC（\`type: moc\`），把相关笔记链接进来。
6. **产出**：需要对外交付的内容写进 \`05 我的产出\`，引用提炼笔记，不要复制原文。
`
}

export async function runInit({ ctx, vaultRoot, config }) {
  const vault = new Vault(vaultRoot)
  const created = []
  const present = []
  const warnings = []

  for (const folder of REQUIRED_DIRS) {
    const dir = vault.dir(folder)
    if (await exists(dir)) present.push(`${folder}/`)
    else {
      try {
        await ensureDir(dir)
      } catch (error) {
        throw new Error(
          `无法创建知识库目录 ${dir}：${error.message}。请确认 cordis.patch.yml 里的 vault 指向本机可写路径（当前：${vault.root}）。`,
        )
      }
      created.push(`${folder}/`)
    }
    if (folder === FOLDERS.note) {
      for (const kind of NOTE_KINDS) {
        const sub = path.join(dir, kind)
        const rel = `${folder}/${kind}/`
        if (await exists(sub)) present.push(rel)
        else {
          await ensureDir(sub)
          created.push(rel)
        }
      }
    }
  }

  const templateFile = vault.file(TEMPLATE_PATH)
  if (await exists(templateFile)) present.push(TEMPLATE_PATH.replace(/\\/g, '/'))
  else {
    await writeText(templateFile, TEMPLATE_CONTENT)
    created.push(TEMPLATE_PATH.replace(/\\/g, '/'))
  }

  const specFile = vault.file(SPEC_PATH)
  if (await exists(specFile)) present.push(SPEC_PATH.replace(/\\/g, '/'))
  else {
    await writeText(specFile, specContent(vault.root))
    created.push(SPEC_PATH.replace(/\\/g, '/'))
  }

  // Verify the spec still names the six folders; a half-written spec is a real defect.
  if (await exists(specFile)) {
    const text = await readText(specFile)
    const missing = REQUIRED_DIRS.filter((folder) => !text.includes(folder))
    if (missing.length) warnings.push(`知识库规范.md 未提到目录：${missing.join('、')}`)
    for (const heading of ['目录分工', '标签维度', '命名规则', '处理流程']) {
      if (!text.includes(heading)) warnings.push(`知识库规范.md 缺少「${heading}」一节`)
    }
  }

  const counts = {}
  for (const folder of [FOLDERS.inbox, FOLDERS.raw, FOLDERS.moc, FOLDERS.output]) {
    counts[folder] = (await vault.list(folder)).length
  }
  counts[FOLDERS.note] = (await vault.list(FOLDERS.note, true)).length

  return {
    ok: true,
    stage: 'init',
    vault: vault.root.replace(/\\/g, '/'),
    summary: created.length
      ? `新建 ${created.length} 项，其余结构已就绪。`
      : '目录、模板、规范均已存在，未做改动。',
    created,
    present,
    warnings,
    counts,
    tree: await vault.tree(),
    taskFile: config?.taskFile ?? '',
  }
}
