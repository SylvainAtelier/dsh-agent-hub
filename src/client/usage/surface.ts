/**
 * An opaque, readable surface for the popover. The host sidebar may paint a
 * translucent background (or none at all over a vibrancy window), so the
 * layers under the anchor are composited into one solid color, and the text
 * color is forced to WCAG AA contrast against it.
 */

type Rgba = [number, number, number, number]

const DARK_BASE: Rgba = [30, 31, 34, 1]
const LIGHT_BASE: Rgba = [255, 255, 255, 1]
const DARK_TEXT = 'rgb(31, 35, 40)'
const LIGHT_TEXT = 'rgb(236, 236, 238)'

export function parseColor(value: string): Rgba | undefined {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(value)
  if (match === null) return undefined
  const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? Number(match[4].slice(0, -1)) / 100 : Number(match[4])
  return [Number(match[1]), Number(match[2]), Number(match[3]), alpha]
}

function luminance([r, g, b]: Rgba): number {
  const channel = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const css = ([r, g, b]: Rgba): string => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`

/**
 * @param layers - background colors from the anchor outward, as computed styles report them.
 * @param text - the anchor's computed text color.
 */
export function solidSurface(layers: readonly string[], text: string): { background: string; color: string } {
  const textRgba = parseColor(text) ?? [128, 128, 128, 1]
  const stack: Rgba[] = []
  for (const layer of layers) {
    const parsed = parseColor(layer)
    if (parsed === undefined || parsed[3] === 0) continue
    stack.push(parsed)
    if (parsed[3] >= 1) break
  }
  // Nothing opaque underneath: a light text color means a dark theme.
  const opaque = stack.at(-1)?.[3] === 1
  let [r, g, b] = opaque ? stack.pop()! : luminance(textRgba) > 0.5 ? DARK_BASE : LIGHT_BASE
  for (const [lr, lg, lb, a] of stack.reverse()) {
    r = r * (1 - a) + lr * a
    g = g * (1 - a) + lg * a
    b = b * (1 - a) + lb * a
  }
  const background: Rgba = [r, g, b, 1]
  const solidText: Rgba = [textRgba[0], textRgba[1], textRgba[2], 1]
  if (contrast(solidText, background) >= 4.5) return { background: css(background), color: css(solidText) }
  const dark = parseColor(DARK_TEXT)!
  const light = parseColor(LIGHT_TEXT)!
  return { background: css(background), color: contrast(dark, background) >= contrast(light, background) ? DARK_TEXT : LIGHT_TEXT }
}

/**
 * The surface `element` renders on, composited to an opaque color: what a
 * popover portaled out of it (beyond the reach of the host's theme tokens and
 * past a translucent sidebar) should paint.
 */
export function surfaceOf(element: HTMLElement): { background: string; color: string } {
  const layers: string[] = []
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    layers.push(getComputedStyle(node).backgroundColor)
  }
  return solidSurface(layers, getComputedStyle(element).color)
}
