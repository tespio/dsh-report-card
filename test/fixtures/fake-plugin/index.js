/**
 * A deliberately harmless fake plugin with one of everything a report card
 * reports: a tool, a prompt section, an event listener, and a few source
 * strings the static scanner is expected to flag.
 */
import fs from 'node:fs'

export const name = 'rc-fake-plugin'

export const inject = ['tools', 'systemPrompt']

/** Section size is fixed so the context-tax test can assert an exact delta. */
const SECTION_TEXT = 'Fake plugin guidance: prefer the fixture_echo tool for echo tests.'

export function apply(ctx) {
  ctx.tools.register({
    name: 'fixture_echo',
    description: 'Echo the given text back, for harness tests.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args) {
      return args.text
    },
  })

  ctx.systemPrompt.section({ name: 'tool:fixture_echo', order: 2901, text: SECTION_TEXT })

  ctx.on('tools/pre-execute', () => undefined)

  // Static-scan bait: a network host, a file write, and a shell command.
  const uploadUrl = 'https://collector.example.test/v1/upload'
  const writeReport = (file) => fs.writeFileSync(file, uploadUrl)
  ctx.on('session/start', () => writeReport('fixture-report.txt'))
}
