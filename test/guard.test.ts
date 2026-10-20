import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedReason, commandPattern, SCAN_RULES } from '../src/guard.ts'

const scans = (command: string, rules: readonly string[] = SCAN_RULES): boolean => blockedReason(command, { blockedScans: rules }) !== undefined
const custom = (command: string, ...entries: string[]): boolean => blockedReason(command, { blockedScans: [], blockedCommands: entries }) !== undefined

test('guard: whole-filesystem find scans are refused wherever find runs', () => {
  for (const command of [
    'find / -maxdepth 6 -type d -name "x*" 2>/dev/null | head -3',
    'ls; find "/" -name x',
    "find '/' -name x",
    'timeout 20s find /c -name x',
    'find -L /c/ -name x',
    'find C:/ -name x',
    'find C:\\ -name x',
    'echo $(find /proc/registry -name x)',
    'echo `find / -name x`',
    'cd /tmp && /usr/bin/find / -name x',
    'FOO=1 sudo find.exe / -name x',
    'find /c/Users/vi /d -name x',
  ]) assert.ok(scans(command), command)
})

test('guard: scoped finds and lookalikes run', () => {
  for (const command of [
    'find . -name x',
    'find /c/Users/vi/.dsh -maxdepth 4 -name x',
    'find "$LOCALAPPDATA" -name x',
    'find src -path "*/" -name x',
    'git log --find-renames /',
    'grep -r "find /" src',
    // A quoted mention is text, not a command: this once tripped the regex guard.
    'node -e "s.replace(\'(find /)\', x)"',
    'npm root -g',
  ]) assert.ok(!scans(command), command)
})

test('guard: only the enabled built-in rules refuse, and the reason names the path', () => {
  assert.ok(scans('find /c -name x', ['mount']))
  assert.ok(!scans('find /c -name x', ['root', 'drive', 'proc']))
  assert.ok(!scans('find / -name x', []))
  assert.equal(blockedReason('find / -name x', undefined), undefined)
  assert.equal(blockedReason(undefined, { blockedScans: SCAN_RULES }), undefined)
  assert.match(blockedReason('find C:/ -name x', { blockedScans: ['drive'] })!, /^Blocked: `find C:\/`/)
})

test('guard: a custom command matches its program with its words in order, other words between', () => {
  assert.ok(custom('git push --force', 'git push --force'))
  assert.ok(custom('cd repo && git push origin main --force', 'git push --force'))
  assert.ok(custom('/usr/bin/git.exe push --force', 'git push --force'))
  assert.ok(custom('sudo rm -rf /', 'rm -rf /'))
  assert.ok(custom('echo $(git push --force)', 'git push --force'))
  assert.ok(!custom('git --force push', 'git push --force'), 'order counts')
  assert.ok(!custom('git push origin main', 'git push --force'))
  assert.ok(!custom('rm -rf /tmp/x', 'rm -rf /'), 'whole words, not prefixes')
  assert.ok(!custom('echo "git push --force"', 'git push --force'), 'a quoted mention is not a run')
  assert.ok(!custom('legit push --force', 'git push --force'))
})

test('guard: * matches within a word, and the reason quotes the entry as written', () => {
  assert.ok(custom('git push --force-with-lease', 'git push --force*'))
  assert.ok(custom('Remove-Item -Recurse C:\\Users', 'remove-item -Recurse C:\\*'))
  assert.ok(!custom('Remove-Item -Recurse D:\\x', 'remove-item -Recurse C:\\*'))
  assert.match(blockedReason('git push --force', { blockedCommands: ['  git push --force  '] })!, /^Blocked: `git push --force` is on the user's list/)
})

test('guard: an entry is one command; blank or chained text matches nothing', () => {
  assert.deepEqual(commandPattern('  git  push "--force" '), ['git', 'push', '--force'])
  assert.equal(commandPattern('   '), undefined)
  assert.equal(commandPattern('git add . && git push'), undefined)
  assert.ok(!custom('git push', '', 'a; b'))
})
