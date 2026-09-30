import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js/dist/solid.js";
const [count, setCount] = createSignal(1);
const setup = await testRender(() => (() => {
  var _el$ = _$createElement("box"),
    _el$2 = _$createElement("text"),
    _el$3 = _$createTextNode(`Count: `);
  _$insertNode(_el$, _el$2);
  _$insertNode(_el$2, _el$3);
  _$setProp(_el$2, "fg", "#ff00ff");
  _$insert(_el$2, count, null);
  return _el$;
})(), {
  width: 40,
  height: 8
});
try {
  await setup.renderOnce();
  const first = setup.captureCharFrame();
  setCount(2);
  await setup.renderOnce();
  const second = setup.captureCharFrame();
  if (!first.includes('Count: 1') || !second.includes('Count: 2')) throw new Error(JSON.stringify({
    first,
    second
  }));
  process.stdout.write('Solid OpenTUI native fixture passed on Node/macOS arm64\n');
} finally {
  setup.renderer.destroy();
}