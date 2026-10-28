import { createTool } from './src/tool.js'

export const name = 'kb-automation'
export const inject = ['tools']

/**
 * Host-only bundle: one agent tool that automates the six-stage knowledge-base
 * pipeline (init / collect / process / inspect / board / status), where board
 * only returns task-board card plans. Stages 1-4 are init / collect / process / inspect.
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  ctx.effect(() => ctx.tools.register(createTool(ctx, settings)))
}
