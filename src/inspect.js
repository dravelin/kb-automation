import path from 'node:path'
import {
  bigrams,
  clip,
  daysAgo,
  isoDate,
  jaccard,
  noteFileName,
  oneLine,
  parseIsoDate,
  toSentence,
  writeText,
} from './util.js'
import { hasTagPrefix, normalizeTags, orderFields, sectionBody, stringifyFrontmatter } from './frontmatter.js'
import { FOLDERS, KIND_TYPE_TAG, NOTE_KINDS, Vault, noteDate } from './vault.js'
import { asString, asStringArray, complete, extractJson, llmReady } from './llm.js'

export function guessTheme(text, knownThemes) {
  const source = String(text ?? '')
  const hits = []
  for (const theme of knownThemes) {
    const core = String(theme).split('/').pop()
    if (core && source.includes(core)) hits.push({ theme, size: core.length })
  }
  hits.sort((a, b) => b.size - a.size)
  return hits[0]?.theme ?? ''
}

function findMissing(notes) {
  const missing = []
  for (const note of notes) {
    const tags = note.tags ?? []
    const reasons = []
    if (!tags.length) reasons.push('缺少 tags')
    else {
      if (!hasTagPrefix(tags, '主题/')) reasons.push('缺少主题标签')
      if (!hasTagPrefix(tags, '类型/')) reasons.push('缺少类型标签')
    }
    const summaryText = sectionBody(note.body, '摘要').replace(/^关键词[:：].*$/m, '').trim()
    if (summaryText.length < 30) reasons.push(summaryText ? '摘要不足 30 字' : '缺少摘要')
    if (reasons.length) missing.push({ note, reasons })
  }
  return missing
}

async function fixMissing(vault, entry, vocabulary, ctx, signal) {
  const { note, reasons } = entry
  const kind = NOTE_KINDS.includes(note.folder) ? note.folder : '概念'
  const tags = normalizeTags(note.tags ?? [])
  let changed = false

  if (reasons.some((reason) => reason.includes('标签'))) {
    const hint = `${note.title} ${sectionBody(note.body, '摘要')} ${note.body}`
    const theme = tags.find((tag) => tag.startsWith('主题/')) ?? guessTheme(hint, [...vocabulary.主题]) ?? '主题/未分类'
    const nextTags = normalizeTags([
      theme.startsWith('主题/') ? theme : `主题/${theme || '未分类'}`,
      tags.find((tag) => tag.startsWith('类型/')) ?? KIND_TYPE_TAG[kind],
      tags.find((tag) => tag.startsWith('状态/')) ?? '状态/待消化',
      ...tags.filter((tag) => !tag.startsWith('主题/') && !tag.startsWith('类型/') && !tag.startsWith('状态/')),
    ])
    await vault.setTags(note, nextTags)
    changed = true
  }

  const summaryText = sectionBody(note.body, '摘要').replace(/^关键词[:：].*$/m, '').trim()
  if (summaryText.length < 30) {
    let summary = ''
    let keywords = []
    if (llmReady(ctx)) {
      try {
        const reply = await complete(ctx, {
          system: '你是知识库整理助手。只输出 JSON，不要解释。',
          prompt: `为下面这条原子笔记补一段 100 字以内中文摘要和 3~5 个关键词。只输出 JSON：{"summary":"...","keywords":["..."]}\n\n标题：${note.title}\n标签：${(note.tags ?? []).join('、')}\n正文：\n${clip(note.body, 3000)}`,
          signal,
          maxTokens: 600,
        })
        const parsed = extractJson(reply)
        summary = asString(parsed?.summary)
        keywords = asStringArray(parsed?.keywords, 5)
      } catch {
        summary = ''
      }
    }
    if (!summary) {
      const base = sectionBody(note.body, '正文 / 要点') || note.body
      summary = toSentence(base, 100)
      keywords = [...new Set(String(note.title).split(/[\s，,、]+/).filter((word) => word.length >= 2))].slice(0, 4)
    }
    const rest = note.body.replace(/^## 摘要\s*\n[\s\S]*?(?=^##\s)/m, '').trim()
    const rebuilt = `## 摘要\n\n${summary}\n${keywords.length ? `关键词：${keywords.join('、')}` : ''}\n\n${rest}\n`
    await writeText(note.path, `${stringifyFrontmatter(orderFields(note.fields))}\n\n${rebuilt.replace(/\n{3,}/g, '\n\n').trim()}\n`)
    note.body = rebuilt
    changed = true
  }

  return { changed, file: `${FOLDERS.note}/${note.folder}/${note.name}`, reasons }
}

function findDuplicates(notes) {
  const pairs = []
  for (let i = 0; i < notes.length; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      const a = notes[i]
      const b = notes[j]
      const titleSim = jaccard(bigrams(a.title), bigrams(b.title))
      const bodySim = jaccard(bigrams(clip(sectionBody(a.body, '正文 / 要点') || a.body, 500)), bigrams(clip(sectionBody(b.body, '正文 / 要点') || b.body, 500)))
      if (titleSim >= 0.55 || bodySim >= 0.7) {
        pairs.push({
          a: `${FOLDERS.note}/${a.folder}/${a.name}`,
          b: `${FOLDERS.note}/${b.folder}/${b.name}`,
          aTitle: a.title,
          bTitle: b.title,
          titleSim: Number(titleSim.toFixed(2)),
          bodySim: Number(bodySim.toFixed(2)),
          reason:
            titleSim >= 0.55
              ? `标题高度重合（相似度 ${titleSim.toFixed(2)}），很可能在讲同一件事。`
              : `正文用词与结构高度重合（相似度 ${bodySim.toFixed(2)}），可能只是换了说法。`,
        })
      }
    }
  }
  pairs.sort((left, right) => Math.max(right.titleSim, right.bodySim) - Math.max(left.titleSim, left.bodySim))
  return pairs.slice(0, 12)
}

function collectLinks(notes) {
  const byUrl = new Map()
  for (const note of notes) {
    const text = `${note.source}\n${note.body}`
    const urls = String(text).match(/https?:\/\/[^\s)\]"'|<>]+/g) ?? []
    for (const raw of urls) {
      const url = raw.replace(/[.,;，。；]+$/, '')
      if (!url || url.length < 12) continue
      const bucket = byUrl.get(url) ?? { url, files: [] }
      const label = note.folder === FOLDERS.note || note.folder === FOLDERS.moc ? `${note.folder}/${note.name}` : `${note.folder}/${note.name}`
      if (!bucket.files.includes(label)) bucket.files.push(label)
      byUrl.set(url, bucket)
    }
  }
  return [...byUrl.values()]
}

async function checkLink(url) {
  const attempt = async (method) => {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(9000),
      headers: method === 'HEAD' ? undefined : { Range: 'bytes=0-1023', 'User-Agent': 'Mozilla/5.0 (compatible; dsh-kb-automation/1.0)' },
    })
    return response.status
  }
  try {
    const status = await attempt('HEAD')
    if (status === 405 || status === 403 || status === 400) {
      return { status: await attempt('GET'), verified: true }
    }
    return { status, verified: true }
  } catch (error) {
    try {
      return { status: await attempt('GET'), verified: true }
    } catch (inner) {
      return { status: 0, verified: false, error: inner.message || error.message }
    }
  }
}

function findUnsplit(rawNotes, notes) {
  const referenced = new Set()
  for (const note of notes) {
    for (const match of String(note.source ?? '').matchAll(/\[\[([^\]|#]+)/g)) {
      referenced.add(match[1].trim())
    }
  }
  return rawNotes.filter((note) => !referenced.has(note.base)).sort((a, b) => a.name.localeCompare(b.name))
}

async function mapLimit(items, limit, worker) {
  const out = []
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      out[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return out
}

export async function runInspect({ ctx, vaultRoot, config, signal }) {
  const vault = new Vault(vaultRoot)
  const notes = await vault.noteNotes()
  const rawNotes = await vault.rawNotes()
  const mocNotes = await vault.mocNotes()
  const inbox = await vault.inboxNotes()
  const outputs = await vault.outputNotes()
  const warnings = []
  const corpus = await vault.corpus()
  const vocabulary = vault.vocabulary(corpus.notes)

  // 1. Missing fields
  const missing = findMissing(notes)
  const fixed = []
  for (const entry of missing) {
    if (signal?.aborted) break
    try {
      const result = await fixMissing(vault, entry, vocabulary, ctx, signal)
      fixed.push(result)
    } catch (error) {
      warnings.push(`补齐 ${entry.note.name} 失败：${error.message}`)
    }
  }

  // 2. Duplicates
  const duplicates = findDuplicates(notes)

  // 3. Links
  const links = collectLinks([...rawNotes, ...notes, ...mocNotes, ...inbox, ...outputs])
  const linkLimit = Math.max(1, Math.min(Number(config?.linkCheckLimit ?? 20) || 20, 40))
  const targets = links.slice(0, linkLimit)
  const checked = await mapLimit(targets, 4, async (link) => {
    const result = await checkLink(link.url)
    return { ...link, ...result }
  })
  const broken = checked.filter((entry) => !entry.verified || entry.status === 404 || entry.status === 410 || entry.status === 0)
  const unverified = checked.filter((entry) => !entry.verified)
  if (!checked.length) warnings.push('没有找到可检查的外部链接。')

  // 4. Weekly stats
  const today = new Date()
  const start = daysAgo(6, today)
  const allRecent = [...rawNotes, ...notes, ...mocNotes, ...outputs, ...inbox].filter((note) => {
    const date = parseIsoDate(noteDate(note))
    return date ? date >= start : false
  })
  const byFolder = {}
  for (const note of allRecent) {
    const key = note.path.includes(FOLDERS.note) ? `${FOLDERS.note}/${path.basename(path.dirname(note.path))}` : path.basename(path.dirname(note.path))
    byFolder[key] = (byFolder[key] ?? 0) + 1
  }
  const byTheme = {}
  for (const note of allRecent) {
    const themes = (note.tags ?? []).filter((tag) => tag.startsWith('主题/'))
    for (const theme of themes.length ? themes : ['主题/未分类']) byTheme[theme] = (byTheme[theme] ?? 0) + 1
  }
  const weekAddedNotes = allRecent.filter((note) => note.path.includes(FOLDERS.note))

  // 5. Archived originals that produced no atomic note yet
  const unsplitAll = findUnsplit(rawNotes, notes)
  const unsplitFiles = unsplitAll.slice(0, 10).map((note) => `${FOLDERS.raw}/${note.name}`)

  // 6. Report
  const date = isoDate(today)
  const reportFile = path.join(vault.dir(FOLDERS.output), noteFileName(date, '知识库周报'))
  const problemCount = missing.length + duplicates.length + broken.length

  const missingLines = fixed.length
    ? fixed.map((entry) => `- \`${entry.file}\`：${entry.reasons.join('；')} → 已按规范补齐${entry.changed ? '' : '（无变化）'}`)
    : ['- 未发现缺少标签或摘要的提炼笔记。']

  const duplicateLines = duplicates.length
    ? duplicates.map(
        (pair, index) =>
          `${index + 1}. \`${pair.a}\` 与 \`${pair.b}\`\n   - 理由：${pair.reason}\n   - 建议：人工确认后保留信息更全的一篇，把差异补进去再合并；本插件不会自行删除。`,
      )
    : ['- 没有发现高度重复或高度相似的笔记。']

  const linkLines = targets.length
    ? targets.map((entry) => {
        const label = broken.includes(entry) ? '可能失效' : entry.verified ? '正常' : '无法验证'
        return `- [${label}] HTTP ${entry.status || '—'} ${entry.url}\n  - 出现在：${entry.files.slice(0, 4).join('、')}`
      })
    : ['- 库内没有外部链接。']

  const themeLines = Object.entries(byTheme)
    .sort((a, b) => b[1] - a[1])
    .map(([theme, count]) => `- \`${theme}\`：${count} 篇`)
  const folderLines = Object.entries(byFolder)
    .sort((a, b) => b[1] - a[1])
    .map(([folder, count]) => `- \`${folder}\`：${count} 篇`)
  const unsplitLines = unsplitFiles.length
    ? unsplitFiles.map((file) => `- \`${file}\``)
    : ['- 没有待补拆解的原文。']

  const report = `---
title: 知识库周报 ${date}
type: raw
source: 由知识库自动化插件「巡检」生成
author: 我
created: ${date}
tags:
  - 主题/知识管理
  - 类型/观点
  - 状态/已消化
status: processed
---

# 知识库周报 ${date}

## 摘要

本次巡检覆盖提炼笔记 ${notes.length} 篇、原始资料 ${rawNotes.length} 篇、主题索引 ${mocNotes.length} 篇。本周（${isoDate(start)} 至 ${date}）新增 ${allRecent.length} 篇，其中提炼笔记 ${weekAddedNotes.length} 篇。共发现 ${problemCount} 个待处理问题：字段缺失 ${missing.length} 个、疑似重复 ${duplicates.length} 对、可能失效链接 ${broken.length} 条。所有修改都只做补齐与标注，删除与合并一律等你确认。
关键词：巡检、周报、去重、链接检查

## 正文 / 要点

### 一、字段缺失与补齐

${missingLines.join('\n')}

### 二、重复内容与合并建议

${duplicateLines.join('\n')}

### 三、外部链接检查

检查了 ${targets.length} 条链接（共发现 ${links.length} 条，本次上限 ${linkLimit} 条）；无法验证 ${unverified.length} 条。

${linkLines.join('\n')}

### 四、本周统计

- 本周新增笔记：${allRecent.length} 篇（其中提炼笔记 ${weekAddedNotes.length} 篇）
- 全库笔记总数：${notes.length + rawNotes.length + mocNotes.length + outputs.length} 篇（不含收件箱 ${inbox.length} 篇）

按目录分布：

${folderLines.join('\n') || '- （本周无新增）'}

按主题分布：

${themeLines.join('\n') || '- （本周无新增）'}

### 五、待补拆解

${unsplitAll.length} 篇原文已经归档进 \`02 原始资料\`，但还没有被任何 \`03 提炼笔记\` 的 \`source\` 引用——它们缺的是原子笔记，不是归档。

${unsplitLines.join('\n')}

### 六、结论与待办

- 本次自动补齐 ${fixed.filter((entry) => entry.changed).length} 篇笔记的字段，其余缺失项属于判断性问题，未强行改动。
- 重复笔记只给建议清单，需要你确认后再合并；本插件未删除任何文件。
- ${broken.length ? `有 ${broken.length} 条链接可能失效，建议逐条复核是否需要替换来源或标注「链接已失效」。` : '外部链接暂未发现失效项。'}
- 下周待办：清空收件箱（当前 ${inbox.filter((note) => note.status === 'inbox').length} 篇 status=inbox），继续给「知识管理」地图补链接。

## 相关笔记

## 待办 / 延伸问题

- 存疑标注：链接检查只验证 HTTP 状态，无法判断页面内容是否已经替换；重复判定基于字面相似度，不能替代人工判断。
`

  await writeText(reportFile, report)

  return {
    ok: true,
    stage: 'inspect',
    summary: `巡检 ${notes.length} 篇提炼笔记：字段缺失 ${missing.length} 个（已补齐 ${fixed.filter((entry) => entry.changed).length} 篇）、疑似重复 ${duplicates.length} 对、链接问题 ${broken.length} 条、待补拆解 ${unsplitAll.length} 篇；周报已写入 05 我的产出。`,
    warnings,
    missing: fixed.map((entry) => ({ file: entry.file, reasons: entry.reasons, changed: entry.changed })),
    duplicates,
    unsplit: { count: unsplitAll.length, files: unsplitFiles },
    links: {
      checked: targets.length,
      total: links.length,
      broken: broken.map((entry) => ({ url: entry.url, status: entry.status, files: entry.files })),
      unverified: unverified.map((entry) => ({ url: entry.url, error: entry.error })),
    },
    stats: {
      weekStart: isoDate(start),
      weekEnd: date,
      added: allRecent.length,
      addedNotes: weekAddedNotes.length,
      byFolder,
      byTheme,
      totals: {
        notes: notes.length,
        raw: rawNotes.length,
        moc: mocNotes.length,
        outputs: outputs.length,
        inbox: inbox.length,
      },
    },
    problems: problemCount,
    report: `${FOLDERS.output}/${path.basename(reportFile)}`,
  }
}
