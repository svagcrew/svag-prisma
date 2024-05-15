import getSvagJestConfigBase from 'svag-jest/configs/base.js'
import tsconfigData from './tsconfig.json' assert { type: 'json' }
/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  ...getSvagJestConfigBase(tsconfigData),
}