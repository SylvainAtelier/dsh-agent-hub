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
  assert.ok(instructionsText({}, dir)!.includes('keep everything a canvas shows inside its one file'))
  assert.ok(instructionsText({}, 'C:\\Users\\me\\.dsh\\canvases\\')!.includes('(C:/Users/me/.dsh/canvases/<short-kebab-name>.html)'))
  assert.equal(instructionsText({ canvas: false }, dir), undefined)
  assert.equal(instructionsText({ instructions: 'x', canvas: false }, dir), instructionsText({ instructions: 'x' }))
})

test('prompt: the Archify guide follows the canvas guide only when both are on and it is installed', () => {
  const dir = 'C:\\Users\\me\\.dsh\\canvases'
  const skill = 'C:\\Users\\me\\.dsh\\dsh-agent-hub\\archify\\3.2.0\\'
  assert.equal(instructionsText({ archify: false }, dir, skill), instructionsText({}, dir))
  assert.ok(!instructionsText({}, dir, skill)!.includes('Archify'))
  // Switched on but not installed (yet, or the download failed): nothing the models could not follow.
  assert.equal(instructionsText({ archify: true }, dir), instructionsText({}, dir))
  const text = instructionsText({ archify: true }, dir, skill)!
  assert.ok(text.startsWith(instructionsText({}, dir)! + '\n\n'))
  assert.ok(text.includes('read `C:/Users/me/.dsh/dsh-agent-hub/archify/3.2.0/SKILL.md`'))
  assert.ok(text.includes('`node C:/Users/me/.dsh/dsh-agent-hub/archify/3.2.0/bin/archify.mjs`'))
  assert.ok(text.includes('`C:/Users/me/.dsh/canvases/<short-kebab-name>.html` as the output path'))
  // Several diagrams make one canvas: the panel's sandboxed blob frame cannot follow links between files.
  assert.ok(text.includes('deliver one canvas'))
  assert.ok(text.includes('never link the pages to each other'))
  assert.equal(instructionsText({ canvas: false, archify: true }, dir, skill), undefined)
  assert.equal(instructionsText({ archify: true }, undefined, skill), undefined)
})
