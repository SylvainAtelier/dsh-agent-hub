import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOrganizationRegion, parseSentryDetail, parseSentryIssues, parseSentryIssuesUrl, regionUrlOf, seenAt, SentryIssues } from '../src/connectors/sentry.ts'
import type { McpSession } from '../src/connectors/mcp.ts'

test('Sentry issues URL yields organization and project, never a region', () => {
  assert.deepEqual(parseSentryIssuesUrl('https://acme.sentry.io/issues/?environment=staging&project=1234567&statsPeriod=7d'), {
    organization: 'acme', project: '1234567', environment: 'prod', period: '7d',
  })
  assert.deepEqual(parseSentryIssuesUrl('https://sentry.io/organizations/acme/issues/?project=-1'), { organization: 'acme', environment: 'prod', period: '14d' })
  assert.equal(parseSentryIssuesUrl('https://us.sentry.io/issues/'), undefined)
  assert.equal(parseSentryIssuesUrl('https://evilsentry.io/issues/'), undefined)
  assert.equal(parseSentryIssuesUrl('http://acme.sentry.io/issues/'), undefined)
  assert.equal(parseSentryIssuesUrl('https://example.com/issues'), undefined)
  assert.equal(parseSentryIssuesUrl('broken'), undefined)
})

test('Only Sentry region hosts are region URLs', () => {
  assert.equal(regionUrlOf('https://de.sentry.io'), 'https://de.sentry.io')
  assert.equal(regionUrlOf('https://acme.sentry.io'), undefined)
  assert.equal(parseOrganizationRegion({ organizations: [{ slug: 'other', regionUrl: 'https://us.sentry.io' }, { slug: 'acme', regionUrl: 'https://de.sentry.io' }] }, 'acme'), 'https://de.sentry.io')
  assert.equal(parseOrganizationRegion('## **acme**\n\n**Web URL:** https://acme.sentry.io\n**Region URL:** https://de.sentry.io\n', 'acme'), 'https://de.sentry.io')
})

test('Sentry list times are bounded by their rounding', () => {
  const now = Date.parse('2026-10-14T12:00:00Z')
  assert.deepEqual(seenAt('3 hours ago', now), { iso: '2026-10-14T09:00:00.000Z', slackMs: 3_600_000 })
  assert.deepEqual(seenAt('1 minute ago', now), { iso: '2026-10-14T11:59:00.000Z', slackMs: 60_000 })
  assert.equal(seenAt('2026-08-01', now)?.slackMs, 86_400_000)
  assert.deepEqual(seenAt('2026-10-01T10:00:00Z', now), { iso: '2026-10-01T10:00:00.000Z', slackMs: 0 })
  assert.equal(seenAt('N/A', now), undefined)
})

test('Sentry search_issues Markdown is parsed as the server writes it', () => {
  const now = Date.parse('2026-10-14T12:00:00Z')
  const markdown = [
    '# Search Results for "is:unresolved environment:prod"', '',
    '**Suggested presentation:** Cards work well for these issues.', '',
    '**View these results in Sentry**:', 'https://acme.sentry.io/issues/?query=is%3Aunresolved', '',
    'Found **2** issues:', '',
    '## 1. [ACME-5DK](https://acme.sentry.io/issues/ACME-5DK)', '',
    '**Checkout failed**', '',
    '- **Status**: unresolved', '- **Users**: 22', '- **Events**: 1234',
    '- **First seen**: 13 days ago', '- **Last seen**: 3 hours ago',
    '- **Culprit**: `checkout/payment.ts in charge`', '',
    '## 2. [ACME-9Z](https://acme.sentry.io/issues/ACME-9Z)', '',
    '**Worker timeout**', '',
    '- **Events**: 3', '- **Culprit**: `app.views in index`', '',
    '## Next Steps', '', '- Get more details: Use get_sentry_resource',
  ].join('\n')
  const issues = parseSentryIssues(markdown, now)
  assert.equal(issues.length, 2)
  assert.deepEqual({ ...issues[0], raw: undefined }, {
    id: 'ACME-5DK', title: 'Checkout failed', url: 'https://acme.sentry.io/issues/ACME-5DK', culprit: 'checkout/payment.ts in charge',
    firstSeen: '2026-10-01T12:00:00.000Z', lastSeen: '2026-10-14T09:00:00.000Z', lastSeenSlackMs: 3_600_000, events: 1234, users: 22,
    location: { path: 'checkout/payment.ts', function: 'charge' }, raw: undefined,
  })
  assert.equal(issues[1]?.title, 'Worker timeout')
  // A dotted module name is not a file to open.
  assert.equal(issues[1]?.location, undefined)
})

function fakeSession(handlers: Record<string, (args: Record<string, unknown>) => unknown>, schemas: Record<string, string[]>): { session: McpSession; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const session = {
    tools: async () => Object.entries(schemas).map(([name, keys]) => ({ name, inputSchema: { properties: Object.fromEntries(keys.map((key) => [key, {}])) } })),
    tool: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return handlers[name]!(args) },
  } as unknown as McpSession
  return { session, calls }
}

const SEARCH_KEYS = ['organizationSlug', 'query', 'sort', 'projectSlugOrId', 'regionUrl', 'limit', 'period', 'includeExplanation']

test('Sentry list sends the server\'s own arguments with the organization\'s region', async () => {
  const { session, calls } = fakeSession({
    find_organizations: () => ({ organizations: [{ slug: 'acme', regionUrl: 'https://de.sentry.io' }] }),
    search_issues: () => ({ results: [
      { shortId: 'APP-2', title: 'Later', firstSeen: '2026-10-02T00:00:00Z' },
      { shortId: 'APP-1', title: 'Earlier', firstSeen: '2026-10-01T00:00:00Z' },
    ] }),
  }, { find_organizations: ['query'], search_issues: SEARCH_KEYS })
  const issues = new SentryIssues(() => session, { organization: 'acme', project: '7', environment: 'prod', period: '14d' })
  const result = await issues.list('7d', 'age', 'asc')
  assert.deepEqual(result.issues.map((issue) => issue.id), ['APP-1', 'APP-2'])
  const search = calls.find((call) => call.name === 'search_issues')!.args
  assert.deepEqual(search, { organizationSlug: 'acme', projectSlugOrId: '7', query: 'is:unresolved environment:prod', sort: 'new', period: '7d', limit: 100, regionUrl: 'https://de.sentry.io', includeExplanation: false })
  // The region is looked up once.
  await issues.list('14d', 'events', 'desc')
  assert.equal(calls.filter((call) => call.name === 'find_organizations').length, 1)
  assert.equal((await issues.cached('app-1'))?.title, 'Earlier')
})

test('A rejected regionUrl is dropped and the call retried', async () => {
  const { session, calls } = fakeSession({
    find_organizations: () => ({ organizations: [{ slug: 'acme', regionUrl: 'https://us.sentry.io' }] }),
    search_issues: (args) => {
      if (args.regionUrl !== undefined) throw new Error("Invalid regionUrl. The domain 'us.sentry.io' is not allowed.")
      return { results: [{ shortId: 'APP-1', title: 'Bad input' }] }
    },
  }, { find_organizations: ['query'], search_issues: SEARCH_KEYS })
  const issues = new SentryIssues(() => session, { organization: 'acme', environment: 'prod', period: '14d' })
  assert.equal((await issues.list('14d', 'lastSeen', 'desc')).issues.length, 1)
  assert.equal(calls.filter((call) => call.name === 'search_issues').length, 2)
  await issues.list('7d', 'lastSeen', 'desc')
  assert.equal(calls.at(-1)?.args.regionUrl, undefined)
})

test('Sentry detail reads the issue resource and takes its exact times', async () => {
  const { session, calls } = fakeSession({
    get_sentry_resource: () => '# Issue APP-1 in **acme**\n\n**Description**: Bad input\n**Culprit**: src/input.ts:9 in parse\n**First Seen**: 2026-10-01T00:00:00.000Z\n**Last Seen**: 2026-10-14T08:12:00.000Z\n**Exception**: TypeError: bad',
  }, { get_sentry_resource: ['url', 'resourceType', 'resourceId', 'organizationSlug'] })
  const issues = new SentryIssues(() => session, { organization: 'acme', environment: 'prod', period: '14d' })
  const detail = await issues.detail({ id: 'APP-1', title: 'Bad input', lastSeen: '2026-10-14T09:00:00.000Z', lastSeenSlackMs: 3_600_000 })
  assert.deepEqual(calls[0]?.args, { resourceType: 'issue', resourceId: 'APP-1', organizationSlug: 'acme' })
  assert.equal(detail.lastSeen, '2026-10-14T08:12:00.000Z')
  assert.equal(detail.lastSeenSlackMs, 0)
  assert.equal(detail.exception, 'TypeError: bad')
  assert.deepEqual(detail.location, { path: 'src/input.ts', line: 9, function: 'parse' })
})

test('Sentry structured results are parsed leniently', () => {
  const [issue] = parseSentryIssues({ results: [{ shortId: 'APP-1', title: 'Bad input', count: '7', metadata: { filename: 'src/input.ts:9' } }] })
  assert.equal(issue?.events, 7)
  const detail = parseSentryDetail(issue!, '**Exception**: TypeError: bad\n**Source**: src/input.ts:9 in parse\n**Trace ID**: abc')
  assert.equal(detail.traceId, 'abc')
})
