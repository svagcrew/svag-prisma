import tsconfigData from './tsconfig.json' with { type: 'json' }
import getSvagJestConfigBase from 'svag-jest/configs/base.js'
/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  ...getSvagJestConfigBase({ tsconfigData }),
}
