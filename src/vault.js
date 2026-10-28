import path from 'node:path'
import {
  basenameNoExt,
  exists,
  isoDate,
  listDir,
  listMarkdownDeep,
  readText,
  toSentence,
  writeText,
} from './util.js'
import {
  getField,
  normalizeTags,
  sectionBody,
  setField,
  splitFrontmatter,
  stringifyFrontmatter,
  orderFields,
  tagList,
} from './frontmatter.js'

export const FOLDERS = {
  inbox: '01 收件箱',
  raw: '02 原始资料',
  note: '03 提炼笔记',
  moc: '04 主题索引',
  output: '05 我的产出',
  system: '06 系统配置',
}

export const NOTE_KINDS = ['概念', '方法', '案例']

export const KIND_TYPE_TAG = {
  概念: '类型/概念',
  方法: '类型/方法论',
  案例: '类型/案例',
}

// Spec §4 lists the accepted 类型 values; anything else is a model invention.
export const ALLOWED_TYPE_TAGS = new Set([
  '类型/概念',
  '类型/方法论',
  '类型/案例',
  '类型/工具',
  '类型/观点',
  '类型/索引',
])

export const REQUIRED_DIRS = [
  FOLDERS.inbox,
  FOLDERS.raw,
  FOLDERS.note,
  FOLDERS.moc,
  FOLDERS.output,
  FOLDERS.system,
]

export const TEMPLATE_PATH = path.join(FOLDERS.system, '笔记模板.md')
export const SPEC_PATH = path.join(FOLDERS.system, '知识库规范.md')

export class Vault {
  constructor(root) {
    this.root = path.resolve(root)
  }

  dir(name) {
    return path.join(this.root, name)
  }

  file(...parts) {
    return path.join(this.root, ...parts)
  }

  async load(file) {
    const text = await readText(file)
    const { fields, body, has } = splitFrontmatter(text)
    return {
      path: file,
      name: path.basename(file),
      base: basenameNoExt(file),
      folder: path.basename(path.dirname(file)),
      text,
      fields,
      body,
      hasFrontmatter: has,
      title: String(getField(fields, 'title') ?? '') || basenameNoExt(file).replace(/^\d{4}-\d{2}-\d{2}-/, ''),
      status: String(getField(fields, 'status') ?? ''),
      tags: normalizeTags(tagList(fields)),
      created: String(getField(fields, 'created') ?? ''),
      source: String(getField(fields, 'source') ?? ''),
      type: String(getField(fields, 'type') ?? ''),
    }
  }

  async list(folderName, deep = false) {
    const dir = this.dir(folderName)
    if (!(await exists(dir))) return []
    return deep ? await listMarkdownDeep(dir) : (await listDir(dir))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => path.join(dir, entry.name))
  }

  async notes(folderName, deep = false) {
    const files = await this.list(folderName, deep)
    files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    const out = []
    for (const file of files) {
      try {
        out.push(await this.load(file))
      } catch {
        out.push({ path: file, name: path.basename(file), base: basenameNoExt(file), folder: folderName, fields: [], body: '', title: basenameNoExt(file), status: '', tags: [], created: '', source: '', type: '', unreadable: true })
      }
    }
    return out
  }

  async inboxNotes() {
    return await this.notes(FOLDERS.inbox)
  }

  async noteNotes() {
    return await this.notes(FOLDERS.note, true)
  }

  async mocNotes() {
    return await this.notes(FOLDERS.moc)
  }

  async rawNotes() {
    return await this.notes(FOLDERS.raw)
  }

  async outputNotes() {
    return await this.notes(FOLDERS.output)
  }

  /** Everything a collector needs to avoid duplicates. */
  async corpus() {
    const groups = [
      await this.inboxNotes(),
      await this.rawNotes(),
      await this.noteNotes(),
      await this.mocNotes(),
      await this.outputNotes(),
    ]
    const urls = new Set()
    const titles = new Set()
    const files = new Set()
    const notes = []
    for (const group of groups) {
      for (const note of group) {
        notes.push(note)
        files.add(note.base)
        titles.add(String(note.title ?? '').trim())
        titles.add(note.base.replace(/^\d{4}-\d{2}-\d{2}-/, ''))
        if (note.source) {
          const match = /https?:\/\/[^\s)\]"'<>]+/g
          const found = String(note.source).match(match) ?? []
          for (const url of found) urls.add(url.replace(/[.,;]+$/, ''))
        }
        const inBody = String(note.body ?? '').match(/https?:\/\/[^\s)\]"'<>]+/g) ?? []
        for (const url of inBody) urls.add(url.replace(/[.,;]+$/, ''))
      }
    }
    return { urls, titles, files, notes }
  }

  /** Tag vocabulary already in use, so new notes reuse the same values. */
  vocabulary(notes) {
    const byDimension = { 主题: new Set(), 类型: new Set(), 状态: new Set() }
    for (const note of notes) {
      for (const tag of note.tags ?? []) {
        const [dimension, ...rest] = tag.split('/')
        if (byDimension[dimension] && rest.length) byDimension[dimension].add(rest.join('/'))
      }
    }
    return byDimension
  }

  async writeNote(file, fields, body) {
    const ordered = orderFields(fields)
    const text = `${stringifyFrontmatter(ordered)}\n\n${String(body ?? '').trim()}\n`
    if (!(await exists(file))) {
      await writeText(file, text)
      return { file, created: true }
    }
    await writeText(file, text)
    return { file, created: false }
  }

  /** Update a field in place, preserving body and field order. */
  async updateField(note, key, value) {
    const fields = note.fields.map((field) => ({ ...field }))
    setField(fields, key, value)
    await this.writeNote(note.path, fields, note.body)
    note.fields = orderFields(fields)
    note.status = String(getField(note.fields, 'status') ?? note.status)
  }

  async setTags(note, tags) {
    const fields = note.fields.map((field) => ({ ...field }))
    const extra = tags.filter((tag) => !['主题', '类型', '状态'].includes(tag.split('/')[0]))
    const ordered = [
      ...tags.filter((tag) => ['主题', '类型', '状态'].includes(tag.split('/')[0])),
      ...extra,
    ]
    setField(fields, 'tags', ordered.length ? ordered : [])
    await this.writeNote(note.path, fields, note.body)
    note.fields = orderFields(fields)
    note.tags = normalizeTags(ordered)
  }

  summaryOf(note) {
    return sectionBody(note.body, '摘要').replace(/^关键词[:：].*$/m, '').trim()
  }

  shortSummary(note, max = 110) {
    return toSentence(this.summaryOf(note), max)
  }

  /** Build a text tree of the vault skeleton for the report. */
  async tree() {
    const lines = [`${this.root.replace(/\\/g, '/')}/`]
    const top = REQUIRED_DIRS
    for (let i = 0; i < top.length; i += 1) {
      const isLastTop = i === top.length - 1
      const connector = isLastTop ? '└── ' : '├── '
      lines.push(`${connector}${top[i]}/`)
      const children = []
      if (top[i] === FOLDERS.note) {
        for (const kind of NOTE_KINDS) {
          const files = await this.list(path.join(FOLDERS.note, kind))
          children.push({ name: `${kind}/`, files })
        }
      } else {
        const files = await this.list(top[i])
        for (const file of files) children.push({ name: path.basename(file), files: [] })
      }
      const indent = isLastTop ? '    ' : '│   '
      for (let j = 0; j < children.length; j += 1) {
        const child = children[j]
        const isLastChild = j === children.length - 1
        lines.push(`${indent}${isLastChild ? '└── ' : '├── '}${child.name}`)
        const childIndent = `${indent}${isLastChild ? '    ' : '│   '}`
        for (let k = 0; k < child.files.length; k += 1) {
          const last = k === child.files.length - 1
          lines.push(`${childIndent}${last ? '└── ' : '├── '}${path.basename(child.files[k])}`)
        }
      }
    }
    return lines.join('\n')
  }
}

export function noteDate(note) {
  const created = String(note.created ?? '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(created)) return created
  const fromName = /^(\d{4}-\d{2}-\d{2})/.exec(note.base)
  return fromName ? fromName[1] : isoDate()
}
