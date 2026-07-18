import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dataPath } from './paths.ts';
import { dataSync } from './data-sync.ts';

export interface Contact {
  id: string;
  name: string;
  emails: string[];
  slackIds: string[];
  role?: string;
  isOperator: boolean;
  isOwner?: boolean;
  firstSeen: number;
  lastSeen: number;
}

const CONTACTS_PATH = dataPath('contacts.json');
let contacts: Contact[] = [];
let byEmail = new Map<string, Contact>();
let bySlackId = new Map<string, Contact>();
let dirty = false;

function rebuildIndexes() {
  byEmail = new Map();
  bySlackId = new Map();
  for (const c of contacts) {
    for (const e of c.emails) byEmail.set(e.toLowerCase(), c);
    for (const s of c.slackIds) bySlackId.set(s, c);
  }
}

function load() {
  if (!existsSync(CONTACTS_PATH)) { contacts = []; rebuildIndexes(); return; }
  try {
    contacts = JSON.parse(readFileSync(CONTACTS_PATH, 'utf-8'));
  } catch (err) { console.error('[contacts] Failed to load contacts.json:', (err as Error).message); contacts = []; }
  rebuildIndexes();
}

function save() {
  if (!dirty) return;
  writeFileSync(CONTACTS_PATH, JSON.stringify(contacts, null, 2));
  dirty = false;
  dataSync.trackWrite('contacts.json');
}

load();

export function find(opts: { email?: string; slackId?: string }): Contact | null {
  if (opts.email) { const c = byEmail.get(opts.email.toLowerCase()); if (c) return c; }
  if (opts.slackId) { const c = bySlackId.get(opts.slackId); if (c) return c; }
  return null;
}

function mergeContacts(a: Contact, b: Contact): Contact {
  const merged: Contact = {
    id: a.firstSeen <= b.firstSeen ? a.id : b.id,
    name: b.lastSeen >= a.lastSeen ? (b.name || a.name) : (a.name || b.name),
    emails: [...new Set([...a.emails, ...b.emails])],
    slackIds: [...new Set([...a.slackIds, ...b.slackIds])],
    role: (b.lastSeen >= a.lastSeen ? b.role : a.role) || a.role || b.role,
    isOperator: a.isOperator || b.isOperator,
    isOwner: a.isOwner || b.isOwner,
    firstSeen: Math.min(a.firstSeen, b.firstSeen),
    lastSeen: Math.max(a.lastSeen, b.lastSeen),
  };
  contacts = contacts.filter(c => c !== a && c !== b);
  contacts.push(merged);
  dirty = true;
  rebuildIndexes();
  return merged;
}

export function upsert(opts: { email?: string; slackId?: string; name?: string; role?: string }): Contact {
  const byE = opts.email ? byEmail.get(opts.email.toLowerCase()) : null;
  const byS = opts.slackId ? bySlackId.get(opts.slackId) : null;

  if (byE && byS && byE !== byS) {
    const merged = mergeContacts(byE, byS);
    if (opts.name) merged.name = opts.name;
    if (opts.role) merged.role = opts.role;
    merged.lastSeen = Date.now();
    dirty = true;
    save();
    console.log(`[contacts] Merged: ${merged.emails.join(',')} + ${merged.slackIds.join(',')}`);
    return merged;
  }

  const existing = byE || byS;
  if (existing) {
    let changed = false;
    if (opts.email && !existing.emails.includes(opts.email.toLowerCase())) {
      existing.emails.push(opts.email.toLowerCase());
      changed = true;
    }
    if (opts.slackId && !existing.slackIds.includes(opts.slackId)) {
      existing.slackIds.push(opts.slackId);
      changed = true;
    }
    if (opts.name && opts.name !== existing.name) {
      existing.name = opts.name;
      changed = true;
    }
    if (opts.role && opts.role !== existing.role) {
      existing.role = opts.role;
      changed = true;
    }
    existing.lastSeen = Date.now();
    if (changed) {
      dirty = true;
      rebuildIndexes();
      save();
    }
    return existing;
  }

  const contact: Contact = {
    id: crypto.randomUUID(),
    name: opts.name || opts.email?.split('@')[0] || 'Unknown',
    emails: opts.email ? [opts.email.toLowerCase()] : [],
    slackIds: opts.slackId ? [opts.slackId] : [],
    role: opts.role,
    isOperator: false,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
  };
  contacts.push(contact);
  dirty = true;
  rebuildIndexes();
  save();
  console.log(`[contacts] New: ${contact.name} (${[...contact.emails, ...contact.slackIds].join(', ')})`);
  return contact;
}

export function seedOperators(whitelist: string[]) {
  for (const email of whitelist) {
    const existing = find({ email });
    const c = upsert({ email, ...(existing ? {} : { name: email.split('@')[0] }) });
    if (!c.isOperator) { c.isOperator = true; dirty = true; }
  }
  save();
}

export function formatUserBlock(contact: Contact | null): string {
  if (!contact) return '<current_user>unknown</current_user>';
  const lines = [`name: ${contact.name}`];
  if (contact.emails.length) lines.push(`email: ${contact.emails[0]}`);
  if (contact.role) lines.push(`title: ${contact.role}`);
  if (contact.isOwner) lines.push('role: owner');
  else if (contact.isOperator) lines.push('role: operator');
  return `<current_user>\n${lines.join('\n')}\n</current_user>`;
}

export function formatRoster(): string {
  if (!contacts.length) return '';
  const operators = contacts.filter(c => c.isOperator);
  const others = contacts.filter(c => !c.isOperator);
  const fmt = (c: Contact, tag: string) => {
    const parts = [c.emails[0] || 'no email', tag];
    if (c.role) parts.push(c.role);
    if (c.slackIds.length) parts.push(`slack:${c.slackIds.join(',')}`);
    return `- ${c.name} (${parts.join(', ')})`;
  };
  const lines = [
    ...operators.map(c => fmt(c, c.isOwner ? 'owner' : 'operator')),
    ...others.map(c => fmt(c, 'contact')),
  ];
  return `<known_contacts>\n${lines.join('\n')}\n</known_contacts>`;
}

export function getByRole(role: string): Contact[] {
  if (role === 'owner') return contacts.filter(c => c.isOwner);
  if (role === 'operator') return contacts.filter(c => c.isOperator);
  return contacts.filter(c => c.role === role);
}

export function getAll(): Contact[] { return contacts; }
