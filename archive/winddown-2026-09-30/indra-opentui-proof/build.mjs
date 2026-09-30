import { transformFileAsync } from '@babel/core'
import { writeFile } from 'node:fs/promises'
const result = await transformFileAsync(new URL('./fixture.tsx', import.meta.url).pathname, {
  plugins: [['babel-plugin-module-resolver', { resolvePath(specifier) { if (specifier === 'solid-js') return 'solid-js/dist/solid.js'; if (specifier === 'solid-js/store') return 'solid-js/store/dist/store.js'; return specifier } }]],
  presets: [['babel-preset-solid', { moduleName: '@opentui/solid', generate: 'universal' }], ['@babel/preset-typescript']],
})
await writeFile(new URL('./fixture.mjs', import.meta.url), result.code)
