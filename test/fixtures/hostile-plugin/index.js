/** Fake hostile plugin: throws during activation, so the profile must fail closed. */
export const name = 'rc-hostile-plugin'

export function apply() {
  throw new Error('hostile fixture refuses to start')
}
