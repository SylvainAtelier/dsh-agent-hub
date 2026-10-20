import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createCipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  parseArgs, decodeEncryptedKey, decryptAuth, validateAuth, dpapiDecrypt,
  loadCredentials, apiRequest, selectCampaign, execute, runCli, acquireLock,
  isMain, HOST, PROFILE, CAMPAIGNS_PATH,
// @ts-expect-error Standalone JavaScript entry deliberately has no build-time dependency.
} from '../scripts/qoder-daily-credit.mjs';

const auth = { token: 'synthetic-token', machineId: 'synthetic-machine' };
const benefit = { kind: 'CREDIT', amount: 100 };
const campaign = (claimStatus = 'CLAIMABLE', extra = {}) => ({
  campaignKey: 'synthetic-daily', campaignId: 'campaign-1',
  actionType: 'CLAIM_BENEFIT', claimStatus, ...extra,
});
const body = (c = campaign()) => ({ campaigns: [c] });
const options = { claim: true, help: false, campaignKey: 'synthetic-daily' };
function mockRequest(responses: any[]) {
  const calls: any[] = [];
  return {
    calls,
    request: async (...args: any[]) => {
      calls.push(args);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.notEqual(response, undefined, 'unexpected additional request');
      return response;
    },
  };
}
function encrypted(version = 'v10', payload: any = { token: auth.token }, key = Buffer.alloc(32, 3)) {
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  return Buffer.concat([Buffer.from(version), nonce, cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
}

test('arguments are strict and claim always requires an exact key or prefix', () => {
  assert.deepEqual(parseArgs([]), { claim: false, help: false, campaignKey: undefined, campaignPrefix: undefined });
  assert.equal(parseArgs(['--claim', '--campaign-key', 'daily:cn.1']).claim, true);
  for (const args of [ ['--claim'], ['--campaign-key'], ['--campaign-key', '--claim'], ['--foo'], ['--claim=true'], ['--campaign-key=x'], ['--help', '--claim'], ['--help', '--help'], ['--claim', '--claim'], ['--campaign-key', '../bad'], ['--campaign-key', 'bad\r\n'], ['--campaign-key', 'k', '--campaign-key', 'k'], ['positional'] ]) assert.throws(() => parseArgs(args));
});

test('help is JSON-compatible, import safe and never touches credentials, lock, or network', async () => {
  const forbidden = () => { throw new Error('must not execute'); };
  const value = await runCli(['--help'], { lock: forbidden, credentials: forbidden, request: forbidden });
  assert.equal(value.status, 'ok');
  assert.match(value.summary, /--campaign-key/);
  assert.equal(isMain(import.meta.url, 'definitely-not-this-file'), false);
});

test('CLI emits exactly one safe JSON line and nonzero errors without touching a profile', () => {
  for (const [args, expected] of [[['--help'], 0], [['--claim'], 1], [['--invalid'], 1]] as const) {
    const child = spawnSync(process.execPath, ['scripts/qoder-daily-credit.mjs', ...args], { encoding: 'utf8' });
    assert.equal(child.status, expected);
    assert.equal(child.stdout.trim().split('\n').length, 1);
    const parsed = JSON.parse(child.stdout);
    assert.deepEqual(Object.keys(parsed).sort(), ['status', 'summary']);
    assert.doesNotMatch(child.stderr + child.stdout, /synthetic-token|username/);
    if (expected) assert.equal(child.stderr, 'Qoder credit operation did not complete successfully.\n');
  }
});

test('DPAPI prefix, canonical base64 and supported AES envelopes are checked', () => {
  const state = (value: string) => ({ os_crypt: { encrypted_key: value } });
  assert.deepEqual(decodeEncryptedKey(state(Buffer.from('DPAPIcipher').toString('base64'))), Buffer.from('cipher'));
  for (const value of ['', '!!!', Buffer.from('OTHERcipher').toString('base64'), Buffer.from('DPAPI').toString('base64')]) assert.throws(() => decodeEncryptedKey(state(value)));
  for (const version of ['v10', 'v11']) assert.deepEqual(decryptAuth(encrypted(version), Buffer.alloc(32, 3)), { token: auth.token });
  assert.throws(() => decryptAuth(encrypted('v20'), Buffer.alloc(32, 3)));
  assert.throws(() => decryptAuth(encrypted(), Buffer.alloc(16)));
  assert.throws(() => decryptAuth(encrypted(), Buffer.alloc(32, 4)));
  assert.throws(() => decryptAuth(Buffer.alloc(30), Buffer.alloc(32, 3)));
  const tampered = encrypted(); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptAuth(tampered, Buffer.alloc(32, 3)));
});

test('token format is validated and user is optional, discarded and never required', () => {
  assert.deepEqual(validateAuth({ token: auth.token, user: { name: 'SECRET_USERNAME' } }, auth.machineId), auth);
  for (const token of [undefined, '', 'Bearer abc', 'bad\r\nHeader: x', {}, 4]) assert.throws(() => validateAuth({ token }, auth.machineId));
  for (const machine of ['', 'bad\r\nx', 'a/b']) assert.throws(() => validateAuth(auth, machine));
});

test('synthetic credential loading uses only the fixed file names and clears the unprotected key', async () => {
  const key = Buffer.alloc(32, 3);
  const paths: string[] = [];
  const files: Record<string, Buffer> = {
    'Local State': Buffer.from(JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPIsynthetic').toString('base64') } })),
    'auth.v1.dat': encrypted(), 'auth.machine-id': Buffer.from(auth.machineId),
  };
  const value = await loadCredentials('synthetic-profile', {
    fsRead: async (file: string) => { paths.push(file); return Buffer.from(files[file.split(/[\\/]/).pop()!]); },
    unprotect: async () => key,
  });
  assert.deepEqual(value, auth);
  assert.equal(paths.length, 3);
  assert.ok(key.every((byte) => byte === 0));
  let spawned = false;
  await assert.rejects(loadCredentials('synthetic-profile', {
    fsRead: async (file: string) => file.endsWith('Local State') ? Buffer.from(JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPIsynthetic').toString('base64') } })) : Buffer.from('unsupported'),
    unprotect: async () => { spawned = true; return key; },
  }));
  assert.equal(spawned, false);
});

function fakeChild(onEnd: (child: any) => void) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = new EventEmitter(); child.stdin.end = (input: string) => { child.input = input; queueMicrotask(() => onEnd(child)); };
  child.kill = () => { child.killed = true; };
  return child;
}

test('DPAPI uses an absolute PowerShell path, EncodedCommand, stdin and memory-only stdout', async () => {
  let invocation: any[], child: any;
  const key = await dpapiDecrypt(Buffer.from('synthetic-cipher'), {
    systemRoot: 'C:\\Windows',
    spawnImpl: (...args: any[]) => {
      invocation = args;
      child = fakeChild((c) => { c.stdout.emit('data', Buffer.from(Buffer.alloc(32, 6).toString('base64'))); c.emit('close', 0); });
      return child;
    },
  });
  assert.equal(key.length, 32);
  assert.equal(key[0], 6);
  assert.equal(child.input, Buffer.from('synthetic-cipher').toString('base64'));
  assert.match(invocation![0], /^C:\\Windows\\System32\\WindowsPowerShell/);
  assert.ok(invocation![1].includes('-EncodedCommand'));
  const script = Buffer.from(invocation![1].at(-1), 'base64').toString('utf16le');
  assert.doesNotMatch(script, /WriteAllBytes|ReadAllBytes|synthetic-cipher/);
  assert.match(script, /Console\]::In/);
  assert.equal(invocation![2].shell, false);
});

test('DPAPI rejects oversized output, malformed output, child errors and deadlines', async () => {
  for (const behavior of [
    (c: any) => c.stdout.emit('data', Buffer.alloc(5000)),
    (c: any) => { c.stdout.emit('data', Buffer.from('invalid')); c.emit('close', 0); },
    (c: any) => c.emit('error', new Error('SENSITIVE')),
    (c: any) => c.stdin.emit('error', new Error('SENSITIVE')),
    (_c: any) => {},
  ]) {
    let child: any;
    await assert.rejects(dpapiDecrypt(Buffer.from('synthetic'), { systemRoot: 'C:\\Windows', timeoutMs: 5, spawnImpl: () => (child = fakeChild(behavior)) }), /^Error: dpapi$/);
    assert.equal(child.killed, true);
  }
});

test('default check can only GET, and does not auto-select the first benefit', async () => {
  for (const campaignKey of [undefined, options.campaignKey]) {
    const mock = mockRequest([body()]);
    assert.equal((await execute({ claim: false, campaignKey }, { auth, request: mock.request })).status, 'ok');
    assert.deepEqual(mock.calls.map((c) => c[0]), ['GET']);
  }
});

test('default check exposes only validated campaign keys and statuses, capped at ten', async () => {
  const campaigns = [
    null,
    campaign('CLAIMABLE', { campaignKey: 'bad\r\nKEY', token: 'SERVER_SECRET' }),
    campaign('CLAIMABLE', { campaignKey: 'not-benefit', actionType: 'OTHER' }),
    campaign('UNKNOWN', { campaignKey: 'unknown-status' }),
    campaign('CLAIMABLE', { campaignKey: 123 }),
    ...Array.from({ length: 12 }, (_, index) => campaign(index % 2 ? 'CLAIMED' : 'CLAIMABLE', { campaignKey: `safe-${index}`, user: { name: 'SECRET_USERNAME' }, token: 'SERVER_SECRET' })),
  ];
  const mock = mockRequest([{ campaigns, user: { name: 'TOP_SECRET' } }]);
  const output = await execute({ claim: false }, { auth, request: mock.request });
  assert.equal(output.status, 'ok');
  for (let i = 0; i < 10; i++) assert.ok(output.summary.includes(`safe-${i}=${i % 2 ? 'CLAIMED' : 'CLAIMABLE'}`));
  assert.doesNotMatch(output.summary, /safe-10|safe-11|bad|not-benefit|unknown-status|SECRET|synthetic-token/);
  assert.deepEqual(mock.calls.map((call) => call[0]), ['GET']);
});

test('default check with no supported target says check only and never implies a claim', async () => {
  for (const campaigns of [[], [campaign('UNKNOWN')], [campaign('CLAIMABLE', { campaignKey: 'invalid/key' })]]) {
    const mock = mockRequest([{ campaigns }]);
    const output = await execute({ claim: false }, { auth, request: mock.request });
    assert.equal(output.status, 'ok');
    assert.match(output.summary, /Check only: no supported target campaigns found; no POST sent/);
    assert.doesNotMatch(output.summary, /100|verified|Claim confirmed/);
    assert.equal(mock.calls.length, 1);
  }
});

test('exact campaign selection rejects mismatches, duplicates, invalid status, action or injected ID', () => {
  for (const data of [ {}, body(campaign('CLAIMABLE', { campaignKey: 'other' })), { campaigns: [campaign(), campaign()] }, body(campaign('CLAIMABLE', { actionType: 'OTHER' })), body(campaign('UNKNOWN')), body(campaign('CLAIMABLE', { campaignId: '../injected?x=1' })), body(campaign('CLAIMABLE', { campaignId: 1.1 })) ]) assert.throws(() => selectCampaign(data, options.campaignKey));
});

test('explicit unsupported initial benefits are rejected before POST', async () => {
  for (const advertised of [{ amount: 99, kind: 'CREDIT' }, { amount: 100, kind: 'credits' }, { unknown: 'SECRET_SERVER_VALUE' }, {}, null, undefined]) {
    const mock = mockRequest([body(campaign('CLAIMABLE', { benefit: advertised }))]);
    const output = await execute(options, { auth, request: mock.request });
    assert.equal(output.status, 'error');
    assert.match(output.summary, /no POST sent/);
    assert.doesNotMatch(output.summary, /SECRET_SERVER_VALUE/);
    assert.deepEqual(mock.calls.map((call) => call[0]), ['GET']);
  }
});

test('explicit initial 100 CREDIT still requires post-claim confirmation', async () => {
  const mock = mockRequest([body(campaign('CLAIMABLE', { benefit })), { status: 'CLAIMED', benefit }, body()]);
  assert.equal((await execute(options, { auth, request: mock.request })).status, 'unknown');
  assert.deepEqual(mock.calls.map((call) => call[0]), ['GET', 'POST', 'GET']);
});

test('success requires a follow-up GET and explicit 100 CREDIT evidence', async () => {
  const mock = mockRequest([body(), { status: 'CLAIMED', benefit }, body(campaign('CLAIMED'))]);
  assert.equal((await execute(options, { auth, request: mock.request })).status, 'ok');
  assert.deepEqual(mock.calls.map((c) => c.slice(0, 2)), [['GET', CAMPAIGNS_PATH], ['POST', `${CAMPAIGNS_PATH}/campaign-1/claim`], ['GET', CAMPAIGNS_PATH]]);
});

test('already claimed never POSTs; replay is verified with another GET', async () => {
  const already = mockRequest([body(campaign('CLAIMED'))]);
  assert.equal((await execute(options, { auth, request: already.request })).status, 'ok');
  assert.equal(already.calls.length, 1);
  const replay = mockRequest([body(), { status: 'CLAIMED', replayed: true, benefit }, body(campaign('CLAIMED'))]);
  assert.match((await execute(options, { auth, request: replay.request })).summary, /replayed/);
});

test('timeout after POST queries once and never resends, even if the outcome is unknown', async () => {
  for (const confirmation of [body(campaign('CLAIMED', { benefit })), body(), new Error('network secret')]) {
    const mock = mockRequest([body(), new Error('POST timeout'), confirmation]);
    const output = await execute(options, { auth, request: mock.request });
    assert.equal(output.status, !(confirmation instanceof Error) && 'benefit' in confirmation.campaigns[0] ? 'ok' : 'unknown');
    assert.deepEqual(mock.calls.map((c) => c[0]), ['GET', 'POST', 'GET']);
    assert.doesNotMatch(JSON.stringify(output), /synthetic-token|network secret|POST timeout/);
  }
});

test('a contradictory final benefit cannot be overridden by a 100-credit receipt', async () => {
  const mock = mockRequest([body(), { status: 'CLAIMED', benefit }, body(campaign('CLAIMED', { benefit: { amount: 99, kind: 'CREDIT' } }))]);
  assert.equal((await execute(options, { auth, request: mock.request })).status, 'unknown');
});

test('a non200 POST is reconciled only by GET and never retried', async () => {
  const calls: string[] = [];
  let reads = 0;
  const request = async (method: string, url: string, credentials: any) => {
    calls.push(method);
    if (method === 'POST') return apiRequest(method, url, credentials, transport({ status: 500 }));
    return ++reads === 1 ? body() : body(campaign('CLAIMED', { benefit }));
  };
  assert.equal((await execute(options, { auth, request })).status, 'ok');
  assert.deepEqual(calls, ['GET', 'POST', 'GET']);
});

test('unknown/mismatched benefit or changed campaign identity cannot infer 100 credits', async () => {
  for (const final of [campaign('CLAIMED'), campaign('CLAIMED', { benefit: { amount: 100, kind: 'UNKNOWN' } }), campaign('CLAIMED', { benefit: { amount: '100', kind: 'CREDIT' } }), campaign('CLAIMED', { benefit: { amount: 99, kind: 'CREDIT' } }), campaign('CLAIMED', { campaignId: 'changed', benefit })]) {
    const mock = mockRequest([body(), { replayed: true }, body(final)]);
    assert.equal((await execute(options, { auth, request: mock.request })).status, 'unknown');
  }
});

function transport({ status = 200, data = '{"campaigns":[]}', type = 'application/json', error = '', never = false, chunks = false } = {}) {
  const calls: any[] = [];
  let request: any;
  const requestImpl = (options: any, callback: any) => {
    calls.push(options);
    request = new EventEmitter(); request.destroy = () => { request.destroyed = true; };
    request.end = () => queueMicrotask(() => {
      if (never) return;
      if (error === 'request') { request.emit('error', new Error('SECRET')); return; }
      const response: any = new EventEmitter();
      response.statusCode = status; response.headers = { 'content-type': type }; response.complete = true;
      response.destroy = () => {};
      callback(response);
      if (error) { response.emit(error, new Error('SECRET')); return; }
      if (chunks) for (const char of data) response.emit('data', Buffer.from(char));
      else response.emit('data', Buffer.from(data));
      response.emit('end');
    });
    return request;
  };
  return { requestImpl, calls, get request() { return request; } };
}

test('HTTPS pins CN domain and enforces strict status, JSON and bounded bodies', async () => {
  const good = transport({ chunks: true });
  assert.deepEqual(await apiRequest('GET', CAMPAIGNS_PATH, auth, good), { campaigns: [] });
  assert.equal(good.calls[0].hostname, HOST);
  assert.equal(good.calls[0].agent, false);
  for (const settings of [{ status: 302 }, { status: 401 }, { status: 500 }, { data: 'not json' }, { data: '[]' }, { data: 'null' }, { type: 'text/html' }, { error: 'error' }, { error: 'aborted' }, { error: 'request' }]) {
    await assert.rejects(apiRequest('GET', CAMPAIGNS_PATH, auth, transport(settings)));
  }
  await assert.rejects(apiRequest('GET', CAMPAIGNS_PATH, auth, { ...transport(), maxBytes: 2 }));
  await assert.rejects(apiRequest('POST', '/other', auth, good));
  await assert.rejects(apiRequest('GET', CAMPAIGNS_PATH, { ...auth, token: 'bad\r\n' }, good));
});

test('HTTPS total deadline terminates a request with no response', async () => {
  const mock = transport({ never: true });
  await assert.rejects(apiRequest('GET', CAMPAIGNS_PATH, auth, { ...mock, timeoutMs: 5 }), /^Error: deadline$/);
  assert.equal(mock.request.destroyed, true);
});

test('non200 or malformed initial GET is a safe error and no POST occurs', async () => {
  for (const initial of [new Error('401 TOKEN SECRET'), { campaigns: 'bad' }, body(campaign('UNKNOWN'))]) {
    const mock = mockRequest([initial]);
    const output = await execute(options, { auth, request: mock.request });
    assert.equal(output.status, 'error');
    assert.equal(mock.calls.length, 1);
    assert.equal(JSON.stringify(output).includes('SECRET'), false);
  }
});

test('exclusive lock never steals an existing lock and contains no credentials', async () => {
  const writes: string[] = [], deletes: string[] = [];
  let closed = false;
  const release = await acquireLock('synthetic-profile', {
    openImpl: async (_file: string, flags: string, mode: number) => {
      assert.equal(flags, 'wx'); assert.equal(mode, 0o600);
      return { writeFile: async (value: string) => writes.push(value), close: async () => { closed = true; } };
    },
    unlinkImpl: async (file: string) => { deletes.push(file); },
  });
  assert.deepEqual(Object.keys(JSON.parse(writes[0])).sort(), ['owner', 'pid']);
  await release();
  assert.equal(closed, true); assert.equal(deletes.length, 1);
  await assert.rejects(acquireLock('synthetic-profile', { openImpl: async () => { throw new Error('exists'); }, unlinkImpl: async () => { throw new Error('must not unlink'); } }));
});

test('CLI pins CN profile, always releases lock and rejects unsupported platform before credentials', async () => {
  const seen: string[] = [];
  let released = false;
  const output = await runCli([], {
    platform: 'win32', appData: 'C:\\synthetic\\Roaming',
    lock: async (profile: string) => { seen.push(profile); return async () => { released = true; }; },
    credentials: async (profile: string) => { seen.push(profile); throw new Error('RAW_SECRET'); },
  });
  assert.equal(output.status, 'error'); assert.equal(released, true);
  assert.ok(seen.every((value) => value.endsWith(PROFILE)));
  assert.doesNotMatch(JSON.stringify(output), /RAW_SECRET/);
  assert.equal((await runCli([], { platform: 'linux', credentials: () => { throw new Error('must not run'); } })).status, 'error');
});

test('a rotating daily key is claimed through a stable prefix that must match exactly one claim campaign', async () => {
  const live = (status: string, key = 'act-20261013-582') => ({ campaigns: [
    { campaignKey: key, campaignId: 'c-582', actionType: 'CLAIM_BENEFIT', claimStatus: status, benefit: { kind: 'CREDITS', amount: 100 } },
    { campaignKey: 'act-20260901-922', campaignId: 'c-922', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' },
  ] });
  const prefixed = { claim: true, help: false, campaignPrefix: 'act-20261013-' };
  assert.equal(parseArgs(['--claim', '--campaign-prefix', 'act-20261013-']).campaignPrefix, 'act-20261013-');
  for (const args of [['--claim', '--campaign-prefix', 'act'], ['--campaign-prefix', 'act-1', '--campaign-key', 'k']]) assert.throws(() => parseArgs(args));
  const mock = mockRequest([live('CLAIMABLE'), { status: 'CLAIMED', benefit: { kind: 'CREDITS', amount: 100 } }, live('CLAIMED')]);
  const output = await execute(prefixed, { auth, request: mock.request });
  assert.deepEqual(output, { status: 'ok', summary: 'Claim confirmed; 100 credits verified.' })
  assert.equal(mock.calls[1][1], `${CAMPAIGNS_PATH}/c-582/claim`)
  // The confirmation GET stays pinned to the key resolved before POST.
  const moved = mockRequest([live('CLAIMABLE'), { status: 'CLAIMED' }, live('CLAIMED', 'act-20261013-999')]);
  assert.equal((await execute(prefixed, { auth, request: moved.request })).status, 'unknown')
  const none = mockRequest([live('CLAIMABLE', 'act-20261101-1')]);
  const missing = await execute(prefixed, { auth, request: none.request });
  assert.equal(missing.status, 'error'); assert.match(missing.summary, /prefix-not-found.*act-20261101-1=CLAIMABLE/); assert.equal(none.calls.length, 1)
  const two = { campaigns: [...live('CLAIMABLE').campaigns, { ...live('CLAIMABLE').campaigns[0], campaignKey: 'act-20261013-583', campaignId: 'c-583' }] };
  const ambiguous = mockRequest([two]);
  assert.match((await execute(prefixed, { auth, request: ambiguous.request })).summary, /ambiguous-prefix/); assert.equal(ambiguous.calls.length, 1)
});
