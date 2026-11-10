/** Fake bundle fixture: a real bundle wrapper around one trivial tool. */
export const name = 'rc-fake-bundle'

export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'fake_bundle_ping',
    description: 'Return pong. Used to give the automatic report card something to find.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute() {
      return 'pong'
    },
  }))
}
