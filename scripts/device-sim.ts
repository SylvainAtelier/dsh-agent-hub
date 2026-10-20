/** Manual protocol smoke test; not ESP32 firmware. Never prints the PSK. */
import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { connect, pair, sendFrame, type Paired } from '../src/device/client.ts'

const [host = '127.0.0.1', rawPort = '7655', file = '.device-sim.json'] = process.argv.slice(2)
const port = Number(rawPort)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Expected a TCP port from 1 to 65535')
const terminal = createInterface({ input: stdin, output: stdout })
let paired: Paired | undefined
try {
  const saved = JSON.parse(await readFile(file, 'utf8')) as { host?: string; port?: number; id?: string; psk?: string; hostId?: string }
  if (saved.host === host && saved.port === port && typeof saved.id === 'string' && typeof saved.psk === 'string') {
    const psk = Buffer.from(saved.psk, 'base64')
    if (psk.length === 32) paired = { host, hostId: saved.hostId ?? '', id: saved.id, psk }
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    terminal.close()
    throw error
  }
}
try {
  if (paired === undefined) {
    console.log('Choose Add device in Agent Hub settings first.')
    paired = await pair(host, port, 'Node simulator', async (code, name) => {
      console.log(`Compare with DSH on ${name}: ${code}`)
      return (await terminal.question('Confirm in DSH, then type yes if both codes match: ')).trim() === 'yes'
    })
    await writeFile(file, JSON.stringify({ host, port, id: paired.id, hostId: paired.hostId, psk: paired.psk.toString('base64') }) + '\n', { mode: 0o600 })
    console.log(`Paired. Credentials saved in ${file}; do not share or commit it.`)
  }
  const ws = await connect(host, port, paired.id, paired.psk)
  ws.on('text', (text) => console.log(text))
  ws.once('close', () => terminal.close())
  sendFrame(ws, { t: 'hello', fw: 'node-simulator', bat: 100 })
  const heartbeat = setInterval(() => sendFrame(ws, { t: 'hello', fw: 'node-simulator', bat: 100 }), 30_000)
  console.log('Enter a JSON device frame per line, or quit. Typing/approval commands have real effects.')
  try {
    for await (const line of terminal) {
      if (line.trim() === 'quit') break
      try {
        const frame: unknown = JSON.parse(line)
        if (frame === null || typeof frame !== 'object') throw new Error('Expected a JSON object')
        ws.send(JSON.stringify(frame))
      } catch (error) { console.error(String(error)) }
    }
  } finally { clearInterval(heartbeat); ws.close() }
} finally { terminal.close() }
