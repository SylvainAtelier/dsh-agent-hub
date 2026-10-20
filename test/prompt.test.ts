import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendedPrompt, INSTRUCTIONS_SECTION, instructionsText, withInstructions } from '../src/prompt.ts'

test('prompt: blank instructions inject nothing', () => {
  assert.equal(instructionsText(undefined), undefined)
  assert.equal(instructionsText({}), undefined)
  assert.equal(instructionsText({ instructions: '  \n ' }), undefined)
  const assembly = { sections: [{ name: 'a', text: 'A' }], tools: [] }
  assert.equal(withInstructions(assembly, undefined), assembly)
})

test('prompt: the instructions are the last, uninterpolated section, never doubled', () => {
  const text = instructionsText({ instructions: '- Answer in {lang}\n' })!
  assert.match(text, /^# Global instructions\n/)
  assert.ok(text.endsWith('- Answer in {lang}'))
  const once = withInstructions({ sections: [{ name: 'a', text: 'A' } as { name: string; text: string; interpolate?: boolean }], tools: [{ name: 'read' }] }, text)
  const twice = withInstructions({ ...once, sections: [...once.sections, { name: 'b', text: 'B' }] }, text)
  assert.deepEqual(twice.sections.map((section) => section.name), ['a', 'b', INSTRUCTIONS_SECTION])
  assert.equal(twice.sections.at(-1)!.interpolate, false)
  assert.deepEqual(twice.tools, [{ name: 'read' }])
})

test('prompt: Claude Code gets the persona, then the instructions', () => {
  assert.equal(appendedPrompt(undefined, undefined), undefined)
  assert.equal(appendedPrompt('You review.', undefined), 'You review.')
  assert.equal(appendedPrompt(undefined, 'G'), 'G')
  assert.equal(appendedPrompt('You review.', 'G'), 'You review.\n\nG')
})

test('prompt: the canvas guide follows the instructions, names the folder, and can be switched off', () => {
  const dir = '/home/me/.dsh/canvases/'
  const both = instructionsText({ instructions: 'Be brief.' }, dir)!
  assert.ok(both.indexOf('# Global instructions') < both.indexOf('# Canvases'))
  assert.ok(both.includes('/home/me/.dsh/canvases/<short-kebab-name>.html'))
  assert.ok(!both.includes('canvases//'))
  assert.ok(instructionsText({}, dir)!.startsWith('# Canvases'))
  assert.ok(instructionsText({}, 'C:\\Users\\me\\.dsh\\canvases\\')!.includes('(C:/Users/me/.dsh/canvases/<short-kebab-name>.html)'))
  assert.equal(instructionsText({ canvas: false }, dir), undefined)
  assert.equal(instructionsText({ instructions: 'x', canvas: false }, dir), instructionsText({ instructions: 'x' }))
})

test('prompt: the Archify guide follows the canvas guide only when both are on', () => {
  const dir = 'C:\\Users\\me\\.dsh\\canvases'
  assert.equal(instructionsText({ archify: false }, dir), instructionsText({}, dir))
  assert.ok(!instructionsText({}, dir)!.includes('archify'))
  const text = instructionsText({ archify: true }, dir)!
  assert.ok(text.startsWith(instructionsText({}, dir)! + '\n\n'))
  assert.ok(text.includes('`archify` skill'))
  assert.ok(text.includes('`C:/Users/me/.dsh/canvases/<short-kebab-name>.html` as the output path'))
  assert.equal(instructionsText({ canvas: false, archify: true }, dir), undefined)
  assert.equal(instructionsText({ archify: true }), undefined)
})
