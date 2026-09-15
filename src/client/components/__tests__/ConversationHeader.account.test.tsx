import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationHeader, describeRunAccount, type RunAccount } from '../ConversationHeader';

// The incident: Lior's runs routed to his own Pro login and failed on its quota, but the pill said only
// `sub`, so it read as the shared agent subscription being exhausted.
const LIOR: RunAccount = { email: 'lior.h@7chairs.org', plan: 'pro', personal: true };

function header(props: Partial<Parameters<typeof ConversationHeader>[0]>) {
  return renderToStaticMarkup(
    <ConversationHeader
      sessionId="s-1234567890"
      agentConfig={{ claudeAuthSource: 'subscription' } as any}
      artifactCount={0}
      getToken={async () => null}
      onConfigSaved={() => {}}
      onDirectivesSaved={() => {}}
      onFork={() => {}}
      onToggleArtifacts={() => {}}
      onScheduleClick={() => {}}
      {...props}
    />,
  );
}

/** The billing pill's outer span (the one carrying the sub/API label). */
function subPill(html: string): string {
  // From the billing pill's opening tag up to the next sibling pill (perms, always rendered).
  const start = html.search(/<span title="[^"]*"(?: data-account="[^"]*")? class="[^"]*whitespace-nowrap/);
  const end = html.indexOf('<span class="inline-flex items-center rounded-md bg-amber-50', start);
  return start >= 0 && end > start ? html.slice(start, end) : '';
}

describe('sub pill names the account a turn ran on', () => {
  it('ran on a personal login: short local-part (capped for narrow), plan only at sm+, full detail in the tooltip', () => {
    const html = header({ sessionLastModel: 'claude-sonnet-5', sessionLastEngine: 'claude-code', sessionLastAccount: LIOR });
    const pill = subPill(html);
    expect(pill).toContain('data-account="lior.h@7chairs.org"');
    expect(pill).toMatch(/>sub<span aria-hidden="true">.*·.*<\/span><span class="max-w-\[4\.5rem\] truncate sm:max-w-\[10rem\]">lior\.h<\/span>/);
    expect(pill).toMatch(/<span class="hidden sm:inline">.*pro<\/span>/);
    // Tooltip: full email, plan, and personal vs shared.
    expect(pill).toContain('Account: lior.h@7chairs.org');
    expect(pill).toContain('Plan: pro');
    expect(pill).toContain('Personal login');
  });

  it('shared login says so', () => {
    const d = describeRunAccount({ email: 'agent@box.io', plan: 'max', personal: false });
    expect(d.localPart).toBe('agent');
    expect(d.title).toContain('Shared login');
    expect(d.title).not.toContain('Personal login');
  });

  it('plan unknown: no plan segment, no "Plan:" line', () => {
    const html = header({ sessionLastModel: 'claude-sonnet-5', sessionLastEngine: 'claude-code', sessionLastAccount: { email: 'x@y.z', personal: false } });
    const pill = subPill(html);
    expect(pill).toContain('>x</span>');
    expect(pill).not.toContain('hidden sm:inline');
    expect(pill).not.toContain('Plan:');
  });

  it('a routed login run shows sub even when the BOX default is an API key', () => {
    const html = header({ agentConfig: { claudeAuthSource: 'api-key' } as any, sessionLastModel: 'claude-sonnet-5', sessionLastEngine: 'claude-code', sessionLastAccount: LIOR });
    expect(subPill(html)).toContain('>sub<');
    expect(html).not.toContain('API·anthropic');
  });

  it('pending (nothing ran): no account is claimed, even if one is passed', () => {
    const html = header({ sessionLastAccount: LIOR });
    const pill = subPill(html);
    expect(pill).toContain('>sub</span>');
    expect(html).not.toContain('lior.h');
    expect(pill).toContain('Nothing has run in this conversation yet');
  });

  it('no recorded account (pre-tracking session / unknown): plain sub, unchanged tooltip', () => {
    const html = header({ sessionLastModel: 'claude-sonnet-5', sessionLastEngine: 'claude-code' });
    const pill = subPill(html);
    expect(pill).toContain('>sub</span>');
    expect(pill).toContain('title="Claude.ai subscription (OAuth login) — no API key in use"');
    expect(pill).not.toContain('data-account');
  });

  it('a turn that ran on another engine never shows a Claude account', () => {
    const html = header({ sessionLastModel: 'cursor/composer-2.5', sessionLastEngine: 'cursor', sessionLastAccount: LIOR });
    expect(html).not.toContain('lior.h');
  });
});
