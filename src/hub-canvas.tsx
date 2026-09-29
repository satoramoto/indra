import { RGBA, type ASCIIFontRenderable, type BoxRenderable, type OptimizedBuffer } from "@opentui/core";
import { createEffect, createSignal, onCleanup, type Accessor, type JSX } from "solid-js";
import { BAR_GLYPH, halfBlockBar, headerGradient, hexRgb, mix, paint, TRACK_COLOR, type Rgb } from "./hub-paint.js";

/**
 * The hub's per-cell drawing. Each piece is one renderable that paints its cells in `renderAfter` with `setCell`, so
 * an animation frame repaints existing cells and never creates a renderable (see the 60-frame test in hub.test.tsx).
 */

const rgba = (rgb: Rgb) => RGBA.fromInts(rgb[0], rgb[1], rgb[2], 255);
/** A renderable scrolled partly out of its scroll box has cells off the buffer; those are skipped, never written. */
const onScreen = (buffer: OptimizedBuffer, x: number, y: number) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < buffer.width && y < buffer.height;

/**
 * The animation frame: a counter that advances every `ms` only while `active` is true, so an idle hub costs no redraws.
 * Tests pass their own frame signal instead.
 */
export function createFrameClock(active: Accessor<boolean>, ms = 150): Accessor<number> {
  const [frame, setFrame] = createSignal(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  createEffect(() => {
    if (active() && !timer) { timer = setInterval(() => setFrame((value) => value + 1), ms); timer.unref?.(); }
    else if (!active() && timer) { clearInterval(timer); timer = undefined; }
  });
  onCleanup(() => { if (timer) clearInterval(timer); });
  return frame;
}

/** Asks for a repaint when anything a `renderAfter` reads changes; those reads are not tracked by Solid. */
function repaintOn(target: () => BoxRenderable | ASCIIFontRenderable | undefined, ...inputs: Accessor<unknown>[]) {
  createEffect(() => { for (const input of inputs) input(); target()?.requestRender(); });
}

/**
 * The header bar: a one-row gradient behind its children (the title and the runtime status), which draw on top with
 * no background of their own. It drifts one full cycle about every 40 s while `drifting`, and holds still otherwise.
 */
export function HeaderBar(props: { frame: Accessor<number>; drifting: Accessor<boolean>; truecolor: boolean; children: JSX.Element }) {
  let ref: BoxRenderable | undefined;
  const phase = () => props.drifting() ? props.frame() / 260 : 0;
  repaintOn(() => ref, phase);
  function paintBar(this: BoxRenderable, buffer: OptimizedBuffer) {
    const colors = headerGradient(this.width, phase());
    const fg = rgba(paint("#EEF2FF", props.truecolor));
    for (let x = 0; x < this.width; x++) if (onScreen(buffer, this.x + x, this.y)) buffer.setCell(this.x + x, this.y, " ", fg, rgba(paint(colors[x], props.truecolor)));
  }
  return <box ref={ref} flexDirection="row" height={1} flexShrink={0} renderAfter={paintBar}>{props.children}</box>;
}

/**
 * The sprint's progress through its ceremony, in half-cell steps (`▀` full cells with a lighter top half, a `▄` leading
 * half). The fill is the current stage's colour.
 */
export function ProgressBar(props: { fraction: Accessor<number>; color: Accessor<string>; width: number; truecolor: boolean; background: string }) {
  let ref: BoxRenderable | undefined;
  repaintOn(() => ref, props.fraction, props.color);
  function paintBar(this: BoxRenderable, buffer: OptimizedBuffer) {
    const fill = paint(props.color(), props.truecolor);
    const sheen = rgba(paint(mix(hexRgb(props.color()), [255, 255, 255], 0.35), props.truecolor));
    const track = rgba(paint(TRACK_COLOR, props.truecolor));
    const panel = rgba(paint(props.background, props.truecolor));
    halfBlockBar(props.fraction(), this.width).forEach((cell, x) => {
      const [fg, bg] = cell === "full" ? [sheen, rgba(fill)] : cell === "half" ? [rgba(fill), track] : [panel, track];
      if (onScreen(buffer, this.x + x, this.y)) buffer.setCell(this.x + x, this.y, BAR_GLYPH[cell], fg, bg);
    });
  }
  return <box ref={ref} width={props.width} height={1} flexShrink={0} renderAfter={paintBar} />;
}

export const SPLASH_FONT = "block" as const;

/**
 * The idle splash: a large "INDRA" wordmark whose letters catch a soft highlight that sweeps left to right. The sweep
 * recolours the glyph cells the font already drew; the font renderable itself never changes.
 */
export function IdleSplash(props: { frame: Accessor<number>; truecolor: boolean; background: string; caption: string; captionColor: string }) {
  let ref: ASCIIFontRenderable | undefined;
  const face = "#A5B4FC";
  const shadow = "#312E81";
  repaintOn(() => ref, props.frame);
  function shimmer(this: ASCIIFontRenderable, buffer: OptimizedBuffer) {
    const span = this.width + 24;
    const center = (props.frame() % span) - 12;
    const { char, bg } = buffer.buffers;
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
      const strength = Math.max(0, 1 - Math.abs(x - center + y) / 6) * 0.55;
      const screenX = this.x + x; const screenY = this.y + y;
      if (!strength || !onScreen(buffer, screenX, screenY)) continue;
      const index = screenY * buffer.width + screenX;
      const glyph = char[index];
      // Only the face (the full blocks) shimmers; the outline and blank cells keep their colour.
      if (glyph !== 0x2588) continue;
      const cellBg = RGBA.fromValues(bg[index * 4], bg[index * 4 + 1], bg[index * 4 + 2], bg[index * 4 + 3]);
      buffer.setCell(screenX, screenY, "█", rgba(paint(mix(hexRgb(face), [255, 255, 255], strength), props.truecolor)), cellBg);
    }
  }
  return (
    <box flexDirection="column" alignItems="center" flexShrink={0} paddingTop={1}>
      <ascii_font ref={ref} text="INDRA" font={SPLASH_FONT} color={[paint(face, props.truecolor), paint(shadow, props.truecolor)].map(rgba)}
        backgroundColor={rgba(paint(props.background, props.truecolor))} selectable={false} renderAfter={shimmer} />
      <text fg={props.captionColor}>{props.caption}</text>
    </box>
  );
}
