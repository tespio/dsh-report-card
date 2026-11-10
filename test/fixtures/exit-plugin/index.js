/** Fake plugin that terminates the host process while activating. */
export const name = 'rc-exit-plugin'

export function apply() {
  process.exit(7)
}
