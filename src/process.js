import path from 'node:path'
import { exists, clip, deleteFile, mtimeDate, noteFileName, oneLine, sanitizeTitle, titleFromFileName, toSentence, writeText, uniqueList } from './util.js'
import {
  getField,
  insertUnderHeading,
  normalizeTags,
  orderFields,
  sectionBody,
  splitFrontmatter,
  stringifyFrontmatter,
  tagList,
} from './frontmatter.js'
import { FOLDERS, KIND_TYPE_TAG, NOTE_KINDS, Vault, noteDate } from './vault.js'
import { asString, asStringArray, complete, extractJson, llmReady } from './llm.js'

const SYSTEM_PROMPT = `你是个人知识库的整理助手，负责把收件箱里的一篇原文拆成原子笔记。
硬性规矩：
1. 一条原子笔记只讲一件事，用自己的话重写，不要成段复制原文。
2. 不确定归属的内容要标注「待核实」，不要强行归类。
3. 不编造原文没有的事实、数字、作者或链接。
4. 标签只用「主题/值」「类型/值」「状态/值」三种前缀；frontmatter 里的标签不带 #。`

// Titles that are section names or boilerplate rather than a reusable idea.
const GENERIC_TITLES = new Set([
  '待核实', '收录理由', '摘要', '要点', '正文', '背景', '定义', '结论', '组件', '价格', '发布',
  '信息边界', '时点约束', '权益变更', '原文摘录', '相关笔记', '待办', '延伸问题', '亮点', '影响',
])

function atomProblem(title, summary, body) {
  if (!title) return '缺少标题'
  if (title.length < 4) return `标题只有 ${title.length} 字，过于笼统`
  if (GENERIC_TITLES.has(title)) return '标题是通用小节名，不是独立知识点'
  if (/^(待核实|收录理由|原文摘录|相关笔记|待办|延伸)/.test(title)) return '标题是模板小节名'
  if (oneLine(summary).length < 20) return '摘要不足 20 字'
  if (String(body ?? '').trim().length < 60) return '正文不足 60 字'
  return ''
}

function buildPrompt(note, vocabulary, existingTitles, rawText) {
  const themeList = [...vocabulary.主题].slice(0, 40)
  const typeList = [...vocabulary.类型].slice(0, 20)
  const statusList = [...vocabulary.状态].slice(0, 8)
  const titles = [...existingTitles].filter(Boolean).slice(0, 90)
  return `请拆解下面这篇收件箱笔记。

## 原文（frontmatter + 正文）
<<<
${clip(rawText, 8000)}
>>>

## 已有标签词表（优先复用，必要时可新增同格式的值）
主题：${themeList.join('、') || '（空）'}
类型：${typeList.join('、') || '（空）'}
状态：${statusList.join('、') || '（空）'}

## 已有笔记标题（「相关笔记」只能从这里选，选不到就留空）
${titles.map((title) => `- ${title}`).join('\n') || '- （空）'}

## 只输出 JSON
{
  "raw": {
    "title": "规范化标题，不超过 30 字",
    "source": "原文链接，原文没有就留空",
    "author": "作者，不知道就留空",
    "tags": ["主题/XX", "类型/观点", "状态/已归档"],
    "summary": "150 字以内中文摘要"
  },
  "atoms": [
    {
      "kind": "概念",
      "title": "原子笔记标题，不超过 20 字",
      "summary": "100 字以内摘要",
      "keywords": ["关键词"],
      "tags": ["主题/XX", "类型/概念", "状态/待消化"],
      "body": "markdown 正文，150~500 字，可用 ### 小标题与列表",
      "related": ["已有笔记标题"]
    }
  ],
  "notes": "一句话说明这次拆解的判断依据"
}

要求：
- kind 只能是 概念 / 方法 / 案例 三者之一；数量 1~4 条。
- 每条 atom 的 tags 恰好包含一个 主题/、一个 类型/、一个 状态/。
- 类型标签必须与 kind 对应：概念→类型/概念，方法→类型/方法论，案例→类型/案例。
- 原文信息不足以下结论时，把不确定之处写进 body，并在 notes 里说明。`
}

function normalizeAtomTags(tags, kind, vocabulary, hint) {
  const cleaned = (tags ?? [])
    .map((tag) => String(tag).trim().replace(/^#/, ''))
    .filter((tag) => /^(主题|类型|状态)\/.+/.test(tag))
  const found = cleaned.find((tag) => tag.startsWith('主题/'))
  const guessed = found ? '' : guessTheme(hint, [...vocabulary.主题])
  const themeValue = found ?? (guessed ? (guessed.startsWith('主题/') ? guessed : `主题/${guessed}`) : '主题/未分类')
  const typeTag = KIND_TYPE_TAG[kind] ?? '类型/概念'
  const status = cleaned.find((tag) => tag.startsWith('状态/')) ?? '状态/待消化'
  return normalizeTags([themeValue, typeTag, status])
}

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

function heuristicAtoms(note) {
  const body = String(note.body ?? '')
  const atoms = []

  const headingBlocks = body.split(/^###\s+/m).slice(1)
  for (const block of headingBlocks) {
    const lines = block.split(/\r?\n/)
    const title = oneLine(lines[0]).slice(0, 24)
    const content = lines.slice(1).join('\n').trim()
    if (!title || content.length < 60) continue
    atoms.push({
      kind: guessKind(`${title}\n${content}`),
      title,
      summary: toSentence(content, 100),
      keywords: [],
      tags: [],
      body: content,
      related: [],
    })
    if (atoms.length >= 4) break
  }

  if (!atoms.length) {
    const bullets = body
      .split(/\r?\n/)
      .map((line) => /^[-*]\s*(?:\*\*)?(.+?)(?:\*\*)?[：:]\s*(.+)$/.exec(line.trim()))
      .filter(Boolean)
    for (const match of bullets) {
      const title = oneLine(match[1]).replace(/^\*\*|\*\*$/g, '').slice(0, 24)
      const content = oneLine(match[2])
      if (!title || content.length < 40) continue
      atoms.push({
        kind: guessKind(`${title}\n${content}`),
        title,
        summary: toSentence(content, 100),
        keywords: [],
        tags: [],
        body: `${title}：${content}`,
        related: [],
      })
      if (atoms.length >= 4) break
    }
  }

  if (!atoms.length) {
    const summary = toSentence(sectionBody(body, '摘要') || body, 100)
    if (summary.length >= 20) {
      atoms.push({
        kind: guessKind(body),
        title: `${String(note.title ?? '').slice(0, 20)}要点`,
        summary,
        keywords: [],
        tags: [],
        body: summary,
        related: [],
      })
    }
  }
  return atoms
}

export function guessKind(text) {
  const source = String(text ?? '')
  if (/案例|实例|复盘|落地|实测|案例拆解/.test(source)) return '案例'
  if (/方法|流程|步骤|框架|做法|技巧|策略|打法/.test(source)) return '方法'
  return '概念'
}

function composeAtomBody(atom, relatedBases) {
  const summary = toSentence(atom.summary || atom.body, 110)
  const keywords = (atom.keywords ?? []).slice(0, 6)
  const body = String(atom.body ?? '').trim()
  const related = relatedBases.map((base) => `- [[${base}]]`)
  return [
    '## 摘要',
    '',
    summary,
    keywords.length ? `关键词：${keywords.join('、')}` : '',
    '',
    '## 正文 / 要点',
    '',
    body,
    '',
    '## 相关笔记',
    '',
    related.length ? related.join('\n') : '- 待补充',
    '',
    '## 待办 / 延伸问题',
    '',
    '- 待核实：本条是否覆盖了原文中最可复用的判断，必要时回原文补正。',
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function findOrCreateMoc(vault, themeTag, date) {
  const name = themeTag.split('/').slice(1).join('/') || '未分类'
  const mocs = await vault.mocNotes()
  const hit = mocs.find((note) => (note.tags ?? []).includes(themeTag))
  if (hit) return { file: hit.path, created: false, base: hit.base }

  const base = noteFileName(date, name)
  const file = path.join(vault.dir(FOLDERS.moc), base)
  if (await exists(file)) return { file, created: false, base: base.replace(/\.md$/i, '') }

  const fields = orderFields([
    { key: 'title', value: name },
    { key: 'type', value: 'moc' },
    { key: 'source', value: '见正文所列来源' },
    { key: 'author', value: '我' },
    { key: 'created', value: date },
    { key: 'tags', value: [themeTag, '类型/索引', '状态/已消化'] },
    { key: 'status', value: 'processed' },
  ])
  const body = [
    `# ${name}`,
    '',
    '## 摘要',
    '',
    `这是 ${name} 的主题地图，只放导航与线索，具体论证在被链接的原子笔记里。`,
    '',
    '## 正文 / 要点',
    '',
    '### 概念',
    '',
    '### 方法',
    '',
    '### 案例',
    '',
    '## 待办 / 延伸问题',
    '',
    '- 继续补链接，直到覆盖该主题下所有值得复用的笔记。',
    '',
  ].join('\n')
  await writeText(file, `${stringifyFrontmatter(fields)}\n\n${body}`)
  return { file, created: true, base: base.replace(/\.md$/i, '') }
}

async function linkIntoMoc(vault, themeTag, atomBase, atomKind, summary, date) {
  const moc = await findOrCreateMoc(vault, themeTag, date)
  const note = await vault.load(moc.file)
  const line = `- [[${atomBase}]] —— ${toSentence(summary, 60)}`
  if (note.body.includes(`[[${atomBase}]]`)) return { ...moc, changed: false }
  const next = insertUnderHeading(note.body, `### ${atomKind}`, line)
  await writeText(moc.file, `${stringifyFrontmatter(orderFields(note.fields))}\n\n${next.trim()}\n`)
  return { ...moc, changed: true }
}

async function archiveOriginal(vault, note) {
  const target = path.join(vault.dir(FOLDERS.raw), note.name)
  if (await exists(target)) return { file: target, created: false }
  const tags = normalizeTags([
    ...note.tags.filter((tag) => !tag.startsWith('状态/')),
    '状态/已归档',
  ])
  const fields = orderFields([
    { key: 'title', value: note.title },
    { key: 'type', value: 'raw' },
    { key: 'source', value: String(getField(note.fields, 'source') ?? '') },
    { key: 'author', value: String(getField(note.fields, 'author') ?? '') },
    { key: 'created', value: noteDate(note) },
    { key: 'tags', value: tags.length ? tags : ['主题/未分类', '类型/观点', '状态/已归档'] },
    { key: 'status', value: 'processed' },
  ])
  for (const field of note.fields) {
    if (!['title', 'type', 'source', 'author', 'created', 'tags', 'status'].includes(field.key)) {
      fields.push({ ...field })
    }
  }
  const body = note.body.trim() ? note.body : '## 摘要\n\n（原文为空，仅保留占位。）\n'
  await writeText(target, `${stringifyFrontmatter(fields)}\n\n${body.trim()}\n`)
  return { file: target, created: true }
}

const NAME_DATE = /^(\d{4}-\d{2}-\d{2})-/
const INBOX_TAGS = ['主题/未分类', '类型/观点', '状态/待归档']
const CANON_KEYS = new Set(['title', 'type', 'source', 'author', 'created', 'tags', 'status'])

function firstHeading(body) {
  const match = /^#\s+(.+)$/m.exec(String(body ?? ''))
  return match ? oneLine(match[1]) : ''
}

/**
 * 用户手丢进收件箱的裸 md 没有 frontmatter/status，先补齐再排队。
 * 已归一化的笔记原样返回，保证幂等（第二次运行不改日期、不改名）。
 */
async function normalizeInboxNote(vault, note) {
  if (note.unreadable) return note
  // 空文件补 frontmatter 会把它变成「有内容」的笔记，正文却仍是空的，原样留在收件箱
  if (!String(note.text ?? '').trim()) return note
  if (note.hasFrontmatter && note.fields.some((field) => field.key === 'status')) return note

  const nameDate = NAME_DATE.exec(note.name)
  const created = oneLine(String(getField(note.fields, 'created') ?? ''))
    || (nameDate ? nameDate[1] : '')
    || (await mtimeDate(note.path))
  const day = /^\d{4}-\d{2}-\d{2}/.test(created) ? created.slice(0, 10) : await mtimeDate(note.path)
  const title = oneLine(String(getField(note.fields, 'title') ?? ''))
    || firstHeading(note.body)
    || titleFromFileName(note.name)
    || '未命名'
  // 用户自带的标签一个都不丢；只在没有状态标签时补一条
  const tags = !note.tags.length
    ? [...INBOX_TAGS]
    : note.tags.some((tag) => tag.startsWith('状态/')) ? [...note.tags] : [...note.tags, '状态/待归档']

  const fields = orderFields([
    { key: 'title', value: title },
    { key: 'type', value: String(getField(note.fields, 'type') ?? '') || 'raw' },
    { key: 'source', value: String(getField(note.fields, 'source') ?? '') },
    { key: 'author', value: String(getField(note.fields, 'author') ?? '') || '我' },
    { key: 'created', value: created },
    { key: 'tags', value: tags },
    { key: 'status', value: 'inbox' },
    // 原文自带的其它字段（如 published）原样保留，不擅自丢弃
    ...note.fields.filter((field) => !CANON_KEYS.has(field.key)).map((field) => ({ ...field })),
  ])

  let target = note.path
  if (!nameDate) {
    const candidate = path.join(vault.dir(FOLDERS.inbox), noteFileName(day, sanitizeTitle(title)))
    // 目标名已被另一篇占用时保持原名，绝不覆盖
    if (!(await exists(candidate))) target = candidate
  }
  const body = String(note.body ?? '').trim()
  await writeText(target, `${stringifyFrontmatter(fields)}\n\n${body}\n`)
  if (target !== note.path) await deleteFile(note.path)
  return await vault.load(target)
}

export async function runProcess({ ctx, vaultRoot, config, signal, limit }) {
  const vault = new Vault(vaultRoot)
  const inbox = []
  for (const note of await vault.inboxNotes()) inbox.push(await normalizeInboxNote(vault, note))
  // 空文件不做归一化，因而没有 status：单独放行，让它落到 kept 分支说明原因
  const pending = inbox.filter((note) => String(note.status || '').toLowerCase() === 'inbox'
    || (!note.unreadable && !String(note.text ?? '').trim()))
  const warnings = []
  const processed = []
  const removed = []
  const kept = []
  const newAtoms = []
  const mocChanges = []
  const usedTags = new Set()
  const heuristicFallback = config?.heuristicFallback === true
  let budget = Number.isFinite(Number(limit)) ? Number(limit) : Infinity

  const corpus = await vault.corpus()
  const vocabulary = vault.vocabulary(corpus.notes)
  const existingTitles = new Set([...corpus.titles].filter(Boolean))
  const existingBases = new Set([...corpus.files].filter(Boolean))

  for (const note of pending) {
    if (signal?.aborted) break
    if (budget <= 0) break
    const text = String(note.text ?? '')
    const bodyOnly = splitFrontmatter(text).body.trim()
    if (!text.trim() || (!note.fields.length && !bodyOnly)) {
      kept.push({ file: `${FOLDERS.inbox}/${note.name}`, reason: '文件为空（0 字节），没有可处理的内容；按约束保留在收件箱。' })
      continue
    }
    if (bodyOnly.length < 40) {
      kept.push({ file: `${FOLDERS.inbox}/${note.name}`, reason: `正文只有 ${bodyOnly.length} 字，信息不足，保留在收件箱待补充。` })
      continue
    }
    budget -= 1

    let extraction = null
    if (llmReady(ctx)) {
      try {
        const reply = await complete(ctx, {
          system: SYSTEM_PROMPT,
          prompt: buildPrompt(note, vocabulary, existingTitles, text),
          signal,
          maxTokens: 3000,
        })
        extraction = extractJson(reply)
        if (!extraction) warnings.push(`${note.name}：模型返回不是合法 JSON。`)
      } catch (error) {
        warnings.push(`${note.name}：模型拆解失败（${error.message}）。`)
      }
    }

    const rawTitle = asString(extraction?.raw?.title) || note.title
    const rawSummary = asString(extraction?.raw?.summary) || toSentence(sectionBody(note.body, '摘要') || note.body, 150)
    let atoms = Array.isArray(extraction?.atoms) ? extraction.atoms : []
    // Rule-based splitting only guesses structure. It is opt-in: a wrong atom is worse than
    // leaving the note in the inbox with a reason.
    if (!atoms.length && heuristicFallback) atoms = heuristicAtoms(note)
    if (!atoms.length) {
      kept.push({
        file: `${FOLDERS.inbox}/${note.name}`,
        reason: llmReady(ctx)
          ? '模型没有给出可用的原子笔记（或返回的不是合法 JSON），保留在收件箱待人工拆分。'
          : '当前没有可用模型，插件不会自行猜测拆分结果，保留在收件箱。',
      })
      continue
    }

    const cleanAtoms = []
    const seenTitles = new Set()
    const rejectedAtoms = []
    for (const atom of atoms) {
      const kindRaw = asString(atom?.kind)
      const kind = NOTE_KINDS.includes(kindRaw) ? kindRaw : guessKind(`${atom?.title ?? ''}${atom?.body ?? ''}`)
      const title = clip(oneLine(asString(atom?.title)), 30)
      const summary = asString(atom?.summary) || toSentence(asString(atom?.body), 100)
      const body = asString(atom?.body) || summary
      const problem = atomProblem(title, summary, body)
      if (problem) {
        rejectedAtoms.push(`${title || '(无标题)'}：${problem}`)
        continue
      }
      if (seenTitles.has(title)) continue
      seenTitles.add(title)
      cleanAtoms.push({
        kind,
        title,
        summary,
        keywords: asStringArray(atom?.keywords, 6),
        tags: normalizeAtomTags(asStringArray(atom?.tags, 6), kind, vocabulary, `${title} ${summary}`),
        body,
        related: asStringArray(atom?.related, 6),
      })
      if (cleanAtoms.length >= 4) break
    }
    if (rejectedAtoms.length) warnings.push(`${note.name}：拒收 ${rejectedAtoms.length} 条不合格的原子笔记（${rejectedAtoms.slice(0, 3).join('；')}）。`)
    if (!cleanAtoms.length) {
      kept.push({ file: `${FOLDERS.inbox}/${note.name}`, reason: '模型给出的条目都不合格（标题过短、摘要/正文过短或过于笼统），保留在收件箱。' })
      continue
    }

    const date = noteDate(note)
    const archive = await archiveOriginal(vault, note)
    // 02 已有同名文件也算内容已归档（created 为 false），收件箱副本同样清理；kept 分支走不到这里
    let removedFile = ''
    try {
      await deleteFile(note.path)
      removedFile = `${FOLDERS.inbox}/${note.name}`
      removed.push(removedFile)
    } catch (error) {
      warnings.push(`${note.name}：收件箱副本删除失败（${error.message}）。`)
    }
    const atomBases = []
    const writtenAtoms = []

    for (const atom of cleanAtoms) {
      const base = noteFileName(date, atom.title)
      const atomBase = base.replace(/\.md$/i, '')
      const file = path.join(vault.dir(FOLDERS.note), atom.kind, base)
      if (existingBases.has(atomBase) || (await exists(file))) {
        atomBases.push(atomBase)
        warnings.push(`原子笔记已存在，跳过：${atom.kind}/${base}`)
        continue
      }
      const relatedBases = atom.related
        .map((title) => [...existingBases].find((value) => value.replace(/^\d{4}-\d{2}-\d{2}-/, '') === sanitizeTitle(title)))
        .filter(Boolean)
      const fields = orderFields([
        { key: 'title', value: atom.title },
        { key: 'type', value: 'note' },
        { key: 'source', value: `[[${note.base}]]` },
        { key: 'author', value: '我' },
        { key: 'created', value: date },
        { key: 'tags', value: atom.tags },
        { key: 'status', value: 'processed' },
      ])
      await writeText(file, `${stringifyFrontmatter(fields)}\n\n${composeAtomBody(atom, relatedBases)}\n`)
      existingBases.add(atomBase)
      existingTitles.add(atom.title)
      atomBases.push(atomBase)
      writtenAtoms.push({ file: `${FOLDERS.note}/${atom.kind}/${base}`, title: atom.title, kind: atom.kind, tags: atom.tags })
      for (const tag of atom.tags) usedTags.add(tag)
      newAtoms.push({ file: `${FOLDERS.note}/${atom.kind}/${base}`, title: atom.title, kind: atom.kind, tags: atom.tags })

      const theme = atom.tags.find((tag) => tag.startsWith('主题/'))
      if (theme) {
        const moc = await linkIntoMoc(vault, theme, atomBase, atom.kind, atom.summary, date)
        if (moc.created) mocChanges.push({ action: 'create', file: `${FOLDERS.moc}/${path.basename(moc.file)}`, theme })
        else if (moc.changed) mocChanges.push({ action: 'link', file: `${FOLDERS.moc}/${path.basename(moc.file)}`, theme })
      }
    }

    const entry = {
      file: `${FOLDERS.inbox}/${note.name}`,
      title: rawTitle,
      summary: toSentence(rawSummary, 80),
      archived: `${FOLDERS.raw}/${path.basename(archive.file)}`,
      archiveCreated: archive.created,
      atoms: writtenAtoms,
      notes: asString(extraction?.notes),
      removed: Boolean(removedFile),
    }
    if (removedFile) entry.removedFile = removedFile
    processed.push(entry)
  }

  const remaining = (await vault.inboxNotes()).filter((note) => String(note.status || '').toLowerCase() === 'inbox')

  return {
    ok: true,
    stage: 'process',
    summary: processed.length
      ? `处理 ${processed.length} 篇，拆出 ${newAtoms.length} 条原子笔记，更新 ${mocChanges.length} 处主题索引，清理收件箱 ${removed.length} 篇。`
      : '收件箱没有待处理的 inbox 笔记。',
    warnings,
    processed,
    removed,
    kept,
    newAtoms,
    moc: mocChanges,
    tags: [...usedTags],
    remaining: remaining.map((note) => `${FOLDERS.inbox}/${note.name}`),
    usedModel: llmReady(ctx),
  }
}
