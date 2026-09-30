import { testRender } from '@opentui/solid'
import { createSignal } from 'solid-js'
const [count, setCount] = createSignal(1)
const setup = await testRender(() => <box><text fg="#ff00ff">Count: {count()}</text></box>, { width: 40, height: 8 })
try {
  await setup.renderOnce()
  const first = setup.captureCharFrame()
  setCount(2)
  await setup.renderOnce()
  const second = setup.captureCharFrame()
  if (!first.includes('Count: 1') || !second.includes('Count: 2')) throw new Error(JSON.stringify({first, second}))
  process.stdout.write('Solid OpenTUI native fixture passed on Node/macOS arm64\n')
} finally { setup.renderer.destroy() }
