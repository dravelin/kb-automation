import { Vault, FOLDERS } from './vault.js'
import { runInit } from './init.js'
import { runCollect } from './collect.js'
import { runProcess } from './process.js'
import { runInspect } from './inspect.js'
import { complete, currentModel, extractJson, llmReady } from './llm.js'

export const DEFAULT_VAULT = 'F:/dataobs'
export const BUILD = 'kb-automation@2.0.3'

const STAGE_LABEL = {
  init: '建库',
  collect: '收集',
  process: '整理',
  inspect: '巡检',
  board: '看板',
  all: '全流程',
  status: '状态',
  selftest: '模型自检',
}

async function runSelftest({ ctx, signal }) {
  const model = currentModel(ctx)
  if (!llmReady(ctx)) {
    return { ok: false, stage: 'selftest', build: BUILD, summary: 'llm 或 agentDefaultModel 服务不可用。', model: null }
  }
  const started = Date.now()
  const reply = await complete(ctx, {
    system: '你是连通性测试助手。只输出 JSON，不要解释。',
    prompt: '只输出 JSON：{"ok":true,"say":"你好"}',
    maxTokens: 200,
    temperature: 0,
    signal,
  })

  const web = ctx.get('web')
  let webProbe = { available: Boolean(web) }
  if (web) {
    try {
      const search = await web.search({ query: 'AI Agent 最新进展', maxResults: 3 })
      webProbe.sources = (search.sources ?? []).length
      webProbe.hasContent = Boolean(search.content)
      webProbe.rawSource = search.sources?.[0] ? { ...search.sources[0] } : null
      webProbe.sourceKeys = search.sources?.[0] ? Object.keys(search.sources[0]) : []
      const first = search.sources?.[0]?.url
      if (first) {
        try {
          const fetched = await web.fetch({ url: first })
          webProbe.fetch = {
            url: first,
            statusCode: fetched?.statusCode ?? null,
            kind: fetched?.body?.kind ?? null,
            chars: fetched?.body?.content?.length ?? 0,
          }
        } catch (error) {
          webProbe.fetch = { url: first, error: error.message }
        }
      }
    } catch (error) {
      webProbe.error = error.message
    }
  }

  return {
    ok: true,
    stage: 'selftest',
    build: BUILD,
    summary: `模型连通正常，用时 ${Date.now() - started} ms。`,
    model,
    reply: reply.slice(0, 600),
    parsed: extractJson(reply) !== null,
    web: webProbe,
  }
}

function textBlocks(text) {
  return [{ type: 'text', text }]
}

function summarizeStage(result) {
  if (!result) return '（未执行）'
  if (result.ok === false) return `失败：${result.summary}`
  return result.summary
}

async function runStatus({ vaultRoot, config }) {
  const vault = new Vault(vaultRoot)
  const inbox = await vault.inboxNotes()
  const notes = await vault.noteNotes()
  const raw = await vault.rawNotes()
  const moc = await vault.mocNotes()
  const outputs = await vault.outputNotes()
  const pending = inbox.filter((note) => String(note.status).toLowerCase() === 'inbox')
  return {
    ok: true,
    stage: 'status',
    build: BUILD,
    summary: `收件箱 ${inbox.length} 篇（待处理 ${pending.length} 篇），提炼笔记 ${notes.length} 篇，原始资料 ${raw.length} 篇，主题索引 ${moc.length} 篇，产出 ${outputs.length} 篇。`,
    vault: vault.root.replace(/\\/g, '/'),
    counts: { inbox: inbox.length, pending: pending.length, notes: notes.length, raw: raw.length, moc: moc.length, outputs: outputs.length },
    pending: pending.map((note) => `${FOLDERS.inbox}/${note.name}`),
    config: { topics: config?.topics ?? null, maxCollect: config?.maxCollect ?? null, linkCheckLimit: config?.linkCheckLimit ?? null },
  }
}

function runBoard({ vault }) {
  const root = vault.replace(/\\/g, '/')
  const timeZone = 'Asia/Shanghai'
  const dailyPrompt =
    `调用 kb_automate 工具，依次执行两个阶段：先 {"stage":"collect","vault":"${root}"}，再 {"stage":"process","vault":"${root}"}。` +
    'process 只处理 01 收件箱里 status=inbox 的笔记，以及没有 frontmatter 的裸 .md（插件会补日期与 frontmatter），其余笔记跳过。' +
    '全部跑完后用简洁中文汇报：collect 新收录几篇及标题；process 处理了几篇、拆出几条原子笔记、更新了哪些主题索引、清理了哪些收件箱副本；' +
    '以及保留在收件箱待人工处理的笔记和原因。'
  const weeklyPrompt =
    `调用 kb_automate 工具，执行 {"stage":"inspect","vault":"${root}"}。` +
    '跑完后用简洁中文汇报：字段缺失的笔记、疑似重复的笔记（只给建议，不删除）、外链检查结果（失效与无法验证各几条）、本周新增统计，以及本次周报写入的完整路径。'

  return {
    ok: true,
    stage: 'board',
    vault: root,
    summary: '产出 2 张定时卡片方案：每日 08:00 收集+提炼，每周一 09:00 巡检+周报；建卡需由 DSH 会话调用 task_board_create。',
    timeZone,
    cards: [
      {
        id: 'daily',
        title: '知识库日常：收集 + 提炼',
        description: '每天 08:00 抓取当日 AI 素材进 01 收件箱，并把收件箱整理成原子笔记：原文搬进 02 原始资料、拆解到 03 提炼笔记、链接进 04 主题索引。',
        prompt: dailyPrompt,
        schedule: { enabled: true, mode: 'cron', cron: '0 8 * * *', timeZone },
      },
      {
        id: 'weekly',
        title: '知识库周检：巡检 + 周报',
        description: '每周一 09:00 巡检整个知识库：字段缺失、疑似重复、外链失效，并把本周新增统计写成周报落到 05 我的产出。',
        prompt: weeklyPrompt,
        schedule: { enabled: true, mode: 'cron', cron: '0 9 * * 1', timeZone },
      },
    ],
    notes: ['建卡需由 DSH 会话调用 task_board_create，再用 task_board_schedule 挂 cron；本阶段不写任何文件。'],
  }
}

function renderResult(args, value) {
  const lines = [`## 知识库${STAGE_LABEL[value.stage] ?? value.stage}`]
  if (value.vault) lines.push(`- 仓库：\`${value.vault}\``)
  lines.push('', value.summary ?? '')

  if (value.stage === 'init') {
    if (value.created?.length) lines.push('', '**新建**', ...value.created.map((item) => `- ${item}`))
    if (value.present?.length) lines.push('', '**已存在（未改动）**', ...value.present.map((item) => `- ${item}`))
    if (value.tree) lines.push('', '```text', value.tree, '```')
  }

  if (value.stage === 'collect') {
    if (value.created?.length) {
      lines.push('', '**新收笔记**')
      for (const item of value.created) lines.push(`- \`${item.file}\` — ${item.title}\n  - ${item.url}`)
    }
    if (value.considered) lines.push('', `候选 ${value.considered} 条，抓到正文 ${value.fetchedPages ?? 0} 页。`)
    if (value.rejected?.length) {
      lines.push('', '**未收录**')
      for (const item of value.rejected) lines.push(`- ${item.title}：${item.reason}`)
    }
  }

  if (value.stage === 'process') {
    if (value.processed?.length) {
      lines.push('', '**处理清单**')
      for (const item of value.processed) {
        lines.push(`- \`${item.file}\``)
        lines.push(`  - 存档：\`${item.archived}\`${item.archiveCreated ? '（新建）' : '（已存在，未覆盖）'}`)
        if (item.removed) lines.push(`  - 收件箱副本：已删除${item.removedFile ? `（\`${item.removedFile}\`）` : ''}`)
        for (const atom of item.atoms) lines.push(`  - 原子笔记：\`${atom.file}\``)
      }
    }
    if (value.removed?.length) {
      lines.push('', '**已清理收件箱**')
      for (const item of value.removed) lines.push(`- \`${item}\``)
    }
    if (value.unsplit?.length) {
      lines.push('', '**未拆解（已归档）**')
      for (const item of value.unsplit) lines.push(`- \`${item.file}\` → \`${item.archived}\`：${item.reason}`)
    }
    if (value.kept?.length) {
      lines.push('', '**保留在收件箱**')
      for (const item of value.kept) lines.push(`- \`${item.file}\`：${item.reason}`)
    }
    if (value.moc?.length) {
      lines.push('', '**主题索引更新**')
      for (const item of value.moc) lines.push(`- ${item.action === 'create' ? '新建' : '补链接'} \`${item.file}\`（${item.theme}）`)
    }
    if (value.tags?.length) lines.push('', `标签：${value.tags.map((tag) => `\`${tag}\``).join('、')}`)
  }

  if (value.stage === 'inspect') {
    if (value.missing?.length) {
      lines.push('', '**字段缺失**')
      for (const item of value.missing) lines.push(`- \`${item.file}\`：${item.reasons.join('；')}`)
    }
    if (value.duplicates?.length) {
      lines.push('', '**疑似重复（仅建议，未删除）**')
      for (const item of value.duplicates) lines.push(`- ${item.aTitle} ↔ ${item.bTitle}（标题 ${item.titleSim} / 正文 ${item.bodySim}）`)
    }
    if (value.links) {
      lines.push('', `**链接**：检查 ${value.links.checked}/${value.links.total}，失效 ${value.links.broken.length}，无法验证 ${value.links.unverified.length}`)
      for (const item of value.links.broken) lines.push(`- HTTP ${item.status || '—'} ${item.url}`)
    }
    if (value.unsplit?.count) {
      lines.push('', `**待补拆解**：${value.unsplit.count} 篇原文已归档进 02 原始资料，但还没有原子笔记。`)
      for (const item of value.unsplit.files) lines.push(`- \`${item}\``)
    }
    if (value.stats) {
      lines.push(
        '',
        `**本周（${value.stats.weekStart} ~ ${value.stats.weekEnd}）**：新增 ${value.stats.added} 篇，其中提炼笔记 ${value.stats.addedNotes} 篇。`,
      )
    }
    if (value.report) lines.push('', `周报：\`${value.report}\``)
  }

  if (value.stage === 'board') {
    if (value.timeZone) lines.push('', `时区：\`${value.timeZone}\``)
    for (const card of value.cards ?? []) {
      lines.push('', `**${card.id} — ${card.title}**`)
      lines.push(`- cron：\`${card.schedule?.cron ?? '—'}\`（${card.schedule?.enabled ? '已启用' : '未启用'}）`)
      lines.push('', '```text', card.prompt, '```')
    }
    if (value.notes?.length) lines.push('', ...value.notes.map((item) => `- ${item}`))
  }

  if (value.stage === 'status') {
    if (value.build) lines.push(`- 构建：${value.build}`)
    if (value.pending?.length) lines.push('', '**待处理**', ...value.pending.map((item) => `- ${item}`))
  }

  if (value.stage === 'selftest') {
    if (value.model) lines.push('', `- 模型：\`${value.model.provider}/${value.model.model}\``)
    if (value.reply) lines.push('', '**原始回复**', '', '```text', value.reply, '```')
    if (value.parsed !== undefined) lines.push('', `JSON 可解析：${value.parsed ? '是' : '否'}`)
    if (value.web) {
      const probe = value.web
      lines.push('', '**Web 探测**', `- 服务：${probe.available ? '可用' : '不可用'}`)
      if (probe.error) lines.push(`- 检索失败：${probe.error}`)
      if (probe.sources !== undefined) lines.push(`- 检索结果：${probe.sources} 条，正文摘要 ${probe.hasContent ? '有' : '无'}`)
      if (probe.fetch) {
        lines.push(
          `- 抓取：${probe.fetch.error ? `失败（${probe.fetch.error}）` : `HTTP ${probe.fetch.statusCode}，${probe.fetch.kind} ${probe.fetch.chars} 字符`}`,
        )
      }
      if (probe.rawSource) lines.push(`- 首条字段：${probe.sourceKeys.join(', ')}`, '', '```json', JSON.stringify(probe.rawSource, null, 2), '```')
    }
  }

  if (value.warnings?.length) lines.push('', '**注意**', ...value.warnings.map((item) => `- ${item}`))

  return textBlocks(lines.join('\n'))
}

export function createTool(ctx, config) {
  const tool = {
    name: 'kb_automate',
    description:
      'Knowledge-base automation for the vault at F:/dataobs. One tool, six stages: ' +
      'init (verify/create the six Chinese folder skeleton, 笔记模板.md, 知识库规范.md), ' +
      'collect (search the web for today\'s AI Agent / AI pricing / AI case material and drop notes into 01 收件箱), ' +
      'process (move every status=inbox note into 02 原始资料, split it into atomic notes under 03 提炼笔记/{概念,方法,案例}, tag them, and link them from 04 主题索引), ' +
      'inspect (check missing fields/duplicates/dead links, then write a weekly report into 05 我的产出), ' +
      'board (return the card plan for a daily and a weekly scheduled task — two cards to create with task_board_create plus cron schedules for task_board_schedule; it writes no file), ' +
      'all (init, collect, process, inspect in order). ' +
      '01 收件箱 is the staging area for raw articles still waiting to be processed: both what the plugin collected and .md files the user saved straight from a browser — frontmatter is optional, the plugin fills in the date and frontmatter. ' +
      'Notes are filed as YYYY-MM-DD-标题.md named after the collection day, with the original publication date kept in frontmatter published. ' +
      'process is a move, not a merge: once an inbox note is archived into 02 原始资料 (also when 02 already holds a file of the same name) the 01 收件箱 copy is deleted; a note whose splitting fails is archived anyway — it only lacks atomic notes, which the weekly report lists under 待补拆解, and only empty or too-short notes stay in 01 收件箱. ' +
      'The only deletion is that archived 01 收件箱 copy — files in 02 原始资料, 03 提炼笔记, 04 主题索引 and 05 我的产出 are never deleted or merged.',
    parameters: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          enum: ['init', 'collect', 'process', 'inspect', 'board', 'all', 'status', 'selftest'],
          description:
            'Which pipeline stage to run. all = init → collect → process → inspect. ' +
            'board = 建卡方案 only (no file writes; the session must call task_board_create then task_board_schedule). ' +
            'selftest only probes the model route.',
        },
        vault: { type: 'string', description: 'Vault root. Defaults to the plugin config (F:/dataobs).' },
        topics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional collect queries; overrides the configured topic list for this call.',
        },
        limit: { type: 'number', description: 'collect: max notes to add (1-7). Also caps notes processed per run.' },
      },
      required: ['stage'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          stage: { type: 'string' },
          summary: { type: 'string' },
          vault: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'stage', 'summary'],
        additionalProperties: true,
      },
      render(args, value) {
        return renderResult(args, value)
      },
    },
    timeoutMs: 1_500_000,
    isConcurrencySafe() {
      return false
    },
    async execute(args, exec) {
      const stage = String(args?.stage ?? 'status')
      const vaultRoot = String(args?.vault ?? config?.vault ?? DEFAULT_VAULT)
      const signal = exec?.signal
      const limit = args?.limit
      const topics = Array.isArray(args?.topics) ? args.topics.map((item) => String(item)).filter(Boolean) : null

      const base = { vault: vaultRoot.replace(/\\/g, '/'), stage }

      if (stage === 'selftest') {
        return JSON.parse(JSON.stringify({ ...(await runSelftest({ ctx, signal })), vault: base.vault }))
      }

      if (stage === 'status') {
        return JSON.parse(JSON.stringify({ ...(await runStatus({ vaultRoot, config })), ...base }))
      }

      if (stage === 'init') {
        return JSON.parse(JSON.stringify({ ...(await runInit({ ctx, vaultRoot, config })), ...base }))
      }

      if (stage === 'collect') {
        const result = await runCollect({ ctx, vaultRoot, config, signal, limit, topicList: topics })
        return JSON.parse(JSON.stringify({ ...result, ...base }))
      }

      if (stage === 'process') {
        const result = await runProcess({ ctx, vaultRoot, config, signal, limit })
        return JSON.parse(JSON.stringify({ ...result, ...base }))
      }
      if (stage === 'inspect') {
        const result = await runInspect({ ctx, vaultRoot, config, signal })
        return JSON.parse(JSON.stringify({ ...result, ...base }))
      }

      if (stage === 'board') {
        return JSON.parse(JSON.stringify({ ...runBoard({ vault: vaultRoot }), ...base }))
      }

      if (stage === 'all') {
        const results = {}
        results.init = await runInit({ ctx, vaultRoot, config })
        results.collect = await runCollect({ ctx, vaultRoot, config, signal, limit, topicList: topics })
        results.process = await runProcess({ ctx, vaultRoot, config, signal })
        results.inspect = await runInspect({ ctx, vaultRoot, config, signal })
        const warnings = Object.values(results).flatMap((result) => result?.warnings ?? [])
        return JSON.parse(
          JSON.stringify({
            ok: true,
            stage: 'all',
            vault: vaultRoot.replace(/\\/g, '/'),
            summary: ['init', 'collect', 'process', 'inspect']
              .map((key) => `${STAGE_LABEL[key]}：${summarizeStage(results[key])}`)
              .join('；'),
            steps: results,
            warnings,
          }),
        )
      }

      throw new Error(`未知阶段：${stage}`)
    },
  }

  return tool
}
