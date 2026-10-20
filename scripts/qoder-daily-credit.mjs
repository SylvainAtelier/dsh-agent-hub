#!/usr/bin/env node
import { readFile, open, unlink } from 'node:fs/promises';
import { createDecipheriv, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST = 'openapi.qoder.com.cn';
export const PROFILE = 'com.qodercn.app.stable';
export const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';
const MAX_FILE = 1024 * 1024;
const MAX_RESPONSE = 256 * 1024;
const REQUEST_MS = 15000;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const result = (status, summary) => ({ status, summary });
export class SafeError extends Error {
  // `detail` is a short fixed-vocabulary hint for the trace log; never a server string or credential.
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new SafeError(code, detail); };
const token = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : 'other';
const why = (error) => error instanceof SafeError ? `${error.code}${error.detail ? `:${error.detail}` : ''}` : 'unexpected';

export function parseArgs(args) {
  const options = { claim: false, help: false, campaignKey: undefined, campaignPrefix: undefined };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!['--help', '--claim', '--campaign-key', '--campaign-prefix'].includes(arg) || seen.has(arg)) fail('arguments');
    seen.add(arg);
    if (arg === '--help') options.help = true;
    if (arg === '--claim') options.claim = true;
    if (arg === '--campaign-key') {
      const key = args[++i];
      if (typeof key !== 'string' || !SAFE_KEY.test(key)) fail('arguments');
      options.campaignKey = key;
    }
    if (arg === '--campaign-prefix') {
      const prefix = args[++i];
      if (typeof prefix !== 'string' || prefix.length < 4 || !SAFE_KEY.test(prefix)) fail('arguments');
      options.campaignPrefix = prefix;
    }
  }
  if (options.help && args.length !== 1) fail('arguments');
  if (options.campaignKey && options.campaignPrefix) fail('arguments');
  if (options.claim && !options.campaignKey && !options.campaignPrefix) fail('arguments');
  return options;
}

export function decodeEncryptedKey(localState) {
  const value = localState?.os_crypt?.encrypted_key;
  if (typeof value !== 'string' || value.length > 16384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('credentials');
  const raw = Buffer.from(value, 'base64');
  if (raw.toString('base64') !== value || raw.length <= 5 || !raw.subarray(0, 5).equals(Buffer.from('DPAPI'))) fail('credentials');
  return raw.subarray(5);
}

export function validateAuth(auth, machineId) {
  // User information is deliberately optional and never returned or logged.
  if (!object(auth) || typeof auth.token !== 'string' || !/^[A-Za-z0-9._~+/=-]{1,16384}$/.test(auth.token)) fail('credentials');
  if (typeof machineId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(machineId)) fail('credentials');
  return { token: auth.token, machineId };
}

export function decryptAuth(raw, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(raw) || raw.length < 32 || raw.length > MAX_FILE) fail('credentials');
  // Only Chromium's three-byte v10/v11 + 12-byte nonce + ciphertext + 16-byte tag layout is supported.
  if (!['v10', 'v11'].some((version) => raw.subarray(0, 3).equals(Buffer.from(version)))) fail('credentials');
  let clear;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(3, 15));
    decipher.setAuthTag(raw.subarray(-16));
    clear = Buffer.concat([decipher.update(raw.subarray(15, -16)), decipher.final()]);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear));
  } catch { fail('credentials'); }
  finally { clear?.fill(0); }
}

export function dpapiDecrypt(encrypted, { spawnImpl = spawn, timeoutMs = 10000, maxBytes = 4096, systemRoot = process.env.SystemRoot } = {}) {
  if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > 16384 || !systemRoot || !path.win32.isAbsolute(systemRoot)) return Promise.reject(new SafeError('dpapi'));
  // The constant script is encoded, ciphertext goes through stdin, and the clear key only through stdout.
  const script = "$ErrorActionPreference='Stop';try { Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $k=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($k)); [Array]::Clear($k,0,$k.Length) } catch { exit 1 }";
  return new Promise((resolve, reject) => {
    let child, timer, done = false, bytes = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const chunk of chunks) chunk.fill(0);
      if (error) { child?.kill(); reject(new SafeError('dpapi')); } else resolve(value);
    };
    try {
      child = spawnImpl(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      timer = setTimeout(() => finish(true), timeoutMs);
      child.on('error', () => finish(true));
      child.stdin.on('error', () => finish(true));
      child.stdout.on('error', () => finish(true));
      child.stderr.on('error', () => finish(true));
      child.stdout.on('data', (chunk) => {
        if (done) return;
        bytes += chunk.length;
        if (bytes > maxBytes) return finish(true);
        chunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk) => { bytes += chunk.length; if (bytes > maxBytes) finish(true); });
      child.on('close', (code) => {
        if (done) return;
        const encoded = Buffer.concat(chunks).toString('utf8');
        if (code !== 0 || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return finish(true);
        const key = Buffer.from(encoded, 'base64');
        if (key.length !== 32 || key.toString('base64') !== encoded) { key.fill(0); return finish(true); }
        finish(false, key);
      });
      child.stdin.end(encrypted.toString('base64'));
    } catch { finish(true); }
  });
}

async function boundedRead(file, fsRead = readFile) {
  // Read via a bounded buffer rather than allocating an unbounded credential file.
  if (fsRead !== readFile) {
    const data = await fsRead(file);
    if (!Buffer.isBuffer(data) || data.length > MAX_FILE) fail('credentials');
    return data;
  }
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(MAX_FILE + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAX_FILE) fail('credentials');
    return buffer.subarray(0, used);
  } finally { await handle.close(); }
}

export async function loadCredentials(profile, { fsRead = readFile, unprotect = dpapiDecrypt } = {}) {
  let key, raw, stage = 'local-state';
  try {
    const state = JSON.parse((await boundedRead(path.join(profile, 'Local State'), fsRead)).toString('utf8'));
    const encrypted = decodeEncryptedKey(state);
    stage = 'auth-file';
    raw = await boundedRead(path.join(profile, 'auth.v1.dat'), fsRead);
    // Reject unsupported auth formats before spawning DPAPI.
    if (raw.length < 32 || !['v10', 'v11'].some((version) => raw.subarray(0, 3).equals(Buffer.from(version)))) fail('credentials');
    stage = 'machine-id';
    const machineId = (await boundedRead(path.join(profile, 'auth.machine-id'), fsRead)).toString('utf8').trim();
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(machineId)) fail('credentials');
    stage = 'dpapi';
    key = await unprotect(encrypted);
    stage = 'decrypt';
    return validateAuth(decryptAuth(raw, key), machineId);
  } catch { fail('credentials', stage); }
  finally { key?.fill(0); raw?.fill(0); }
}

export function apiRequest(method, urlPath, auth, { requestImpl = https.request, timeoutMs = REQUEST_MS, maxBytes = MAX_RESPONSE } = {}) {
  if (!['GET', 'POST'].includes(method) || !(urlPath === CAMPAIGNS_PATH && method === 'GET' || method === 'POST' && /^\/sash\/api\/v1\/me\/campaigns\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/claim$/.test(urlPath))) return Promise.reject(new SafeError('request'));
  try { validateAuth(auth, auth?.machineId); } catch { return Promise.reject(new SafeError('credentials')); }
  return new Promise((resolve, reject) => {
    let req, res, timer, done = false, bytes = 0;
    const chunks = [];
    const finish = (error, data, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) { res?.destroy(); req?.destroy(); reject(new SafeError(error, detail)); } else resolve(data);
    };
    try {
      const headers = { Accept: 'application/json', Authorization: `Bearer ${auth.token}`, 'Cosy-ClientType': '10', 'Cosy-Version': '0.4.7', 'Cosy-MachineId': auth.machineId, 'Cosy-MachineOS': 'windows', 'User-Agent': 'Qoder' };
      if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = '0'; }
      // No redirects, proxy selection, hostname header, or international fallback.
      timer = setTimeout(() => finish('deadline'), timeoutMs);
      req = requestImpl({ hostname: HOST, port: 443, path: urlPath, method, headers, agent: false }, (response) => {
        res = response;
        res.on('error', () => finish('response'));
        res.on('aborted', () => finish('response'));
        res.on('close', () => { if (!res.complete) finish('response'); });
        res.on('data', (chunk) => {
          if (done) return;
          bytes += chunk.length;
          if (bytes > maxBytes) return finish('response');
          chunks.push(Buffer.from(chunk));
        });
        res.on('end', () => {
          if (done) return;
          if (res.statusCode !== 200) return finish('http', undefined, `status-${Number.isInteger(res.statusCode) ? res.statusCode : 'unknown'}`);
          if (!/^application\/json(?:\s*;|$)/i.test(String(res.headers?.['content-type'] || ''))) return finish('response', undefined, 'content-type');
          try {
            const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            if (!object(body)) return finish('response');
            finish(null, body);
          } catch { finish('response'); }
        });
      });
      req.on('error', () => finish('request'));
      req.end();
    } catch { finish('request'); }
  });
}

/** A daily campaign keeps a stable key prefix while its suffix rotates; the prefix must name exactly one claim campaign. */
export function resolveKey(data, prefix) {
  if (!object(data) || !Array.isArray(data.campaigns) || data.campaigns.length > 1000) fail('campaign', 'shape');
  const matches = data.campaigns.filter((c) => object(c) && c.actionType === 'CLAIM_BENEFIT' && typeof c.campaignKey === 'string' && SAFE_KEY.test(c.campaignKey) && c.campaignKey.startsWith(prefix));
  if (matches.length !== 1) fail('campaign', matches.length ? 'ambiguous-prefix' : 'prefix-not-found');
  return matches[0].campaignKey;
}

export function selectCampaign(data, key) {
  if (!object(data) || !Array.isArray(data.campaigns) || data.campaigns.length > 1000) fail('campaign', 'shape');
  // A check without a key only reports availability; it never auto-selects a campaign.
  if (!key) return null;
  const matches = data.campaigns.filter((c) => object(c) && c.campaignKey === key);
  if (matches.length !== 1) fail('campaign', matches.length ? 'ambiguous-key' : 'key-not-found');
  const c = matches[0];
  if (c.actionType !== 'CLAIM_BENEFIT') fail('campaign', `action-${token(c.actionType)}`);
  if (!((typeof c.campaignId === 'string' || typeof c.campaignId === 'number' && Number.isSafeInteger(c.campaignId)) && SAFE_ID.test(String(c.campaignId)))) fail('campaign', 'campaign-id');
  if (!['CLAIMED', 'CLAIMABLE'].includes(c.claimStatus)) fail('campaign', `status-${token(c.claimStatus)}`);
  return c;
}

export function is100Credits(benefit) {
  // The live CN service reports kind 'CREDITS' (observed 2026-10-18); 'CREDIT' is kept for the documented shape.
  return object(benefit) && benefit.amount === 100 && (benefit.kind === 'CREDITS' || benefit.kind === 'CREDIT');
}

const describe = (c) => `key=${token(c.campaignKey)} action=${token(c.actionType)} status=${token(c.claimStatus)}${object(c.benefit) ? ` benefit=${token(String(c.benefit.kind))}:${Number.isFinite(c.benefit.amount) ? c.benefit.amount : 'other'}` : ''}`;
const supported = (data) => data.campaigns.filter((c) => object(c) && c.actionType === 'CLAIM_BENEFIT' && typeof c.campaignKey === 'string' && SAFE_KEY.test(c.campaignKey) && ['CLAIMED', 'CLAIMABLE'].includes(c.claimStatus)).slice(0, 10);
const listKeys = (data) => supported(data).map((c) => `${c.campaignKey}=${c.claimStatus}`).join(', ');

export async function execute(options, { auth, request = apiRequest, trace = () => {} } = {}) {
  validateAuth(auth, auth?.machineId);
  let campaign, campaigns;
  trace(`mode=${options.claim ? 'claim' : 'check'} key=${options.campaignKey ?? 'none'} prefix=${options.campaignPrefix ?? 'none'}`);
  let key = options.campaignKey;
  try {
    campaigns = await request('GET', CAMPAIGNS_PATH, auth);
    if (object(campaigns) && Array.isArray(campaigns.campaigns)) {
      trace(`GET campaigns ok count=${campaigns.campaigns.length}`);
      for (const c of campaigns.campaigns.slice(0, 20)) if (object(c)) trace(`campaign ${describe(c)}`);
    }
    if (options.campaignPrefix) { key = resolveKey(campaigns, options.campaignPrefix); trace(`prefix resolved key=${key}`); }
    campaign = selectCampaign(campaigns, key);
  } catch (error) {
    const reason = why(error);
    trace(`campaign check failed ${reason}`);
    // Name the failing step; when the key simply was not found, show what is available so the task can be corrected.
    const available = error instanceof SafeError && ['key-not-found', 'prefix-not-found', 'ambiguous-prefix'].includes(error.detail) ? ` Available: ${listKeys(campaigns) || 'none'}.` : '';
    return result('error', `Campaign check failed (${reason}).${available}`);
  }
  if (!campaign) {
    if (!supported(campaigns).length) return result('ok', 'Check only: no supported target campaigns found; no POST sent.');
    return result('ok', `Check only; no POST sent. Campaigns (up to 10): ${listKeys(campaigns)}. Supply --campaign-key with an exact key to inspect or claim.`);
  }
  trace(`selected ${describe(campaign)}`);
  if (campaign.claimStatus === 'CLAIMED') return result('ok', 'Campaign already claimed; no POST sent.');
  if (!options.claim) return result('ok', 'Campaign is claimable; check only, no POST sent.');
  if (Object.hasOwn(campaign, 'benefit') && !is100Credits(campaign.benefit)) return result('error', 'Campaign benefit is not verified as 100 CREDIT; no POST sent.');
  let receipt;
  trace('POST claim dispatching (never repeated)');
  try {
    receipt = await request('POST', `${CAMPAIGNS_PATH}/${campaign.campaignId}/claim`, auth);
    trace(`POST claim ok status=${object(receipt) ? token(receipt.status) : 'other'} replayed=${object(receipt) && receipt.replayed === true}`);
  } catch (error) {
    // A dispatched POST is never repeated, even on timeout or a malformed response.
    trace(`POST claim failed ${why(error)}; the outcome is decided only by the confirmation GET`);
  }
  let confirmed;
  try { confirmed = selectCampaign(await request('GET', CAMPAIGNS_PATH, auth), key); }
  catch (error) { trace(`confirmation GET failed ${why(error)}`); return result('unknown', 'Claim outcome unknown; confirmation failed. Do not automatically retry.'); }
  trace(`confirmation ${describe(confirmed)}`);
  if (String(confirmed.campaignId) !== String(campaign.campaignId) || confirmed.claimStatus !== 'CLAIMED') return result('unknown', 'Claim not confirmed. Do not automatically retry.');
  // Supported response contract: benefit: { amount: 100, kind: 'CREDIT' }.
  // This has not been verified against a live account; other kinds/shapes remain unknown, not guessed.
  const receiptConfirmed = object(receipt) && receipt.status === 'CLAIMED' && is100Credits(receipt.benefit);
  if (confirmed.benefit !== undefined && !is100Credits(confirmed.benefit) || !is100Credits(confirmed.benefit) && !receiptConfirmed) return result('unknown', 'Campaign claimed, but 100 credits could not be verified.');
  return result('ok', receipt?.replayed === true ? 'Claim confirmed as replayed; 100 credits verified.' : 'Claim confirmed; 100 credits verified.');
}

export async function acquireLock(profile, { openImpl = open, unlinkImpl = unlink } = {}) {
  const file = path.join(profile, 'daily-credit-claim.lock');
  let handle;
  try {
    handle = await openImpl(file, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, owner: randomUUID() }));
  } catch {
    if (handle) { await handle.close().catch(() => {}); await unlinkImpl(file).catch(() => {}); }
    fail('lock');
  }
  return async () => {
    await handle.close();
    await unlinkImpl(file);
  };
}

export async function runCli(args, deps = {}) {
  let options;
  try { options = parseArgs(args); }
  catch { return result('error', 'Invalid arguments. Use --help.'); }
  if (options.help) return result('ok', 'Usage: qoder-daily-credit.mjs [--campaign-key EXACT_KEY | --campaign-prefix KEY_PREFIX] [--claim]. Default: check only. Claim requires an exact key or a prefix matching exactly one claim campaign. Windows current-user CN profile only. No credentials or network accessed by --help.');
  const platform = deps.platform ?? process.platform;
  const appData = deps.appData ?? process.env.APPDATA;
  if (platform !== 'win32' || typeof appData !== 'string' || !path.win32.isAbsolute(appData)) return result('error', 'Windows CN profile is required.');
  const profile = path.join(appData, PROFILE);
  // Step trace: one timestamped line per stage on stderr, captured into the DSH automation log. No secrets, ever.
  const began = Date.now();
  const trace = deps.trace ?? ((message) => { try { process.stderr.write(`[${new Date().toISOString()}] +${Date.now() - began}ms ${message}\n`); } catch { /* tracing must never change the outcome */ } });
  let release;
  try {
    trace(`start run=${/^[A-Za-z0-9-]{1,64}$/.test(process.env.AUTOMATION_RUN_ID ?? '') ? process.env.AUTOMATION_RUN_ID : 'none'} pid=${process.pid}`);
    release = await (deps.lock ?? acquireLock)(profile);
    trace('profile lock acquired');
    const auth = await (deps.credentials ?? loadCredentials)(profile);
    trace('credentials loaded (not logged)');
    return await execute(options, { auth, request: deps.request ?? apiRequest, trace });
  } catch (error) {
    trace(`failed ${why(error)}`);
    return result('error', error instanceof SafeError && error.code === 'lock' ? 'Profile is locked or unavailable; no credentials accessed. Inspect a stale lock manually.' : `Credential or local operation failed (${why(error)}).`);
  } finally {
    if (release) await release().catch(() => {});
  }
}

export function isMain(metaUrl, argvPath = process.argv[1]) {
  return typeof argvPath === 'string' && path.resolve(argvPath) === fileURLToPath(metaUrl);
}
if (isMain(import.meta.url)) {
  runCli(process.argv.slice(2)).then((output) => {
    process.stdout.write(`${JSON.stringify(output)}\n`);
    if (output.status !== 'ok') process.stderr.write('Qoder credit operation did not complete successfully.\n');
    process.exitCode = output.status === 'ok' ? 0 : output.status === 'unknown' ? 2 : 1;
  }).catch(() => {
    process.stdout.write(`${JSON.stringify(result('error', 'Operation failed.'))}\n`);
    process.stderr.write('Qoder credit operation did not complete successfully.\n');
    process.exitCode = 1;
  });
}
