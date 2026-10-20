// Build on the target OS (macOS linking/signing requires Apple's SDK).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdir, copyFile, chmod, readdir, rename, rm, mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const targets = {
  'x86_64-pc-windows-msvc': ['win32-x64', 'dsh-type.exe'],
  'aarch64-pc-windows-msvc': ['win32-arm64', 'dsh-type.exe'],
  'x86_64-apple-darwin': ['darwin-x64', 'dsh-type'],
  'aarch64-apple-darwin': ['darwin-arm64', 'dsh-type'],
}
const native = { 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc', 'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin' }

/** Keep the installed signing identity when available; never silently downgrade it to ad hoc. */
export function signingIdentity(details, identities, explicit) {
  if (explicit) return explicit
  const previous = /^Authority=(.+)$/m.exec(details)?.[1]
  const entries = [...identities.matchAll(/\b([A-Fa-f0-9]{40})\s+"([^"]+)"/g)]
  if (previous) {
    const same = entries.find((entry) => entry[2] === previous)
    if (!same) throw new Error(`Signing identity unavailable: ${previous}. Installed helper unchanged. Set DSH_SIGN_IDENTITY explicitly to migrate permissions to another identity.`)
    return same[1]
  }
  return entries.find((entry) => entry[2].startsWith('Developer ID Application:'))?.[1]
    ?? entries.find((entry) => entry[2].startsWith('Apple Development:'))?.[1]
    ?? '-'
}

/** Sign and verify off-path. A failed build must not replace the working helper. */
export async function installNative(source, destination, platform, sign = signMac) {
  await mkdir(destination, { recursive: true })
  const name = platform.startsWith('win32') ? 'dsh-type.exe' : 'dsh-type'
  const installed = join(destination, name)
  const stage = await mkdtemp(join(destination, '.native-'))
  // stage is an owned, freshly created directory beneath the verified destination.
  const staged = join(stage, name)
  try {
    await copyFile(source, staged)
    if (!platform.startsWith('win32')) await chmod(staged, 0o755)
    if (platform.startsWith('darwin')) await sign(staged, installed)
    if (platform.startsWith('win32')) {
      // Windows locks a running executable; leave it aside until its process exits.
      await rename(installed, `${installed}.${Date.now()}.old`).catch((error) => { if (error.code !== 'ENOENT') throw error })
    }
    // Same filesystem: on macOS readers see either the old signed file or the new signed file.
    await rename(staged, installed)
    for (const file of await readdir(destination)) {
      if (file.startsWith(`${name}.`) && file.endsWith('.old')) await rm(join(destination, file), { force: true }).catch(() => {})
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

function signMac(staged, installed) {
  // Use a single synchronous inspection so the installed requirement can be tested before publishing.
  const details = existsSync(installed) ? inspectSignature(installed) : ''
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  const identity = signingIdentity(details, identities, process.env.DSH_SIGN_IDENTITY)
  execFileSync('codesign', ['--force', '--sign', identity, '--identifier', 'ai.dsh.type', staged], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--strict', staged], { stdio: 'inherit' })
  const requirement = /^designated => (.+)$/m.exec(details)?.[1]
  if (requirement && identity !== '-' && !details.includes('Signature=adhoc') && !process.env.DSH_SIGN_IDENTITY) {
    execFileSync('codesign', ['--verify', '--strict', '-R', `=${requirement}`, staged], { stdio: 'inherit' })
  }
  if (identity === '-') console.warn('Signed ad hoc: helper-specific macOS permissions may not survive rebuilding. Authorization may instead belong to the launching app.')
  if (process.env.DSH_SIGN_IDENTITY || details.includes('Signature=adhoc') && identity !== '-') {
    console.warn('Signing identity may have changed: macOS may require one-time authorization for the responsible app or helper.')
  }
}

function inspectSignature(file) {
  const result = spawnSync('codesign', ['--display', '--verbose=2', '--requirements', '-', file], { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error(`Cannot inspect installed helper signature: ${result.error?.message ?? result.stderr}`)
  return `${result.stdout}${result.stderr}`
}

async function main() {
  const target = process.argv[2] ?? native[`${process.platform}-${process.arch}`]
  if (!targets[target]) throw new Error('Unsupported native target')
  const [platform, name] = targets[target]
  if ((platform.startsWith('darwin') && process.platform !== 'darwin') || (platform.startsWith('win32') && process.platform !== 'win32')) throw new Error('Build the helper on its target OS')
  const out = join(root, '.native-build')
  const child = spawn('cargo', ['build', '--locked', '--release', '--manifest-path', join(root, 'native/dsh-type/Cargo.toml'), '--target', target, '--target-dir', out], { cwd: root, stdio: 'inherit', windowsHide: true })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`cargo exited ${code}`)))
  })
  await installNative(join(out, target, 'release', name), join(root, 'lib/bin', platform), platform)
  console.log(`Native helper ready: lib/bin/${platform}/${name}`)
  console.log('An already running helper still uses the previous build: turn the clipboard window off and on in plugin settings to reload it.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
