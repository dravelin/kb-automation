import { createTool } from './src/tool.js'

export const name = 'kb-automation'
export const inject = ['tools']

/**
 * Host-only bundle: one agent tool that automates the four-stage knowledge-base
 * pipeline described in F:/test/11/1.md.
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  ctx.effect(() => ctx.tools.register(createTool(ctx, settings)))
}
