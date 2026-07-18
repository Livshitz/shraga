import { useEffect, useState } from 'react';
import { BookOpen, Plus, Trash2, X, Check, Star, Copy, Pencil, Lock, ArrowLeft } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';

type DefaultSkillEntry = string | { name: string; capped?: boolean | number };

function entryName(e: DefaultSkillEntry): string {
  return typeof e === 'string' ? e : e.name;
}
function isCapped(e: DefaultSkillEntry): boolean {
  if (typeof e === 'string') return false;
  return e.capped === true || (typeof e.capped === 'number' && e.capped > 0);
}
function isDefault(defaults: DefaultSkillEntry[], name: string): boolean {
  return defaults.some(e => entryName(e) === name);
}
function findEntry(defaults: DefaultSkillEntry[], name: string): DefaultSkillEntry | undefined {
  return defaults.find(e => entryName(e) === name);
}

interface Props {
  getToken: () => Promise<string | null>;
  onSkillsChange?: (skills: string[]) => void;
  trigger?: React.ReactNode;
}

async function apiFetch(path: string, token: string, opts?: RequestInit) {
  return fetch(path, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts?.headers ?? {}) } });
}

type SidebarAction = null | 'create' | 'rename' | 'duplicate';

export function SkillsManager({ getToken, onSkillsChange, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<string[]>([]);
  const [builtins, setBuiltins] = useState<string[]>([]);
  const [defaults, setDefaults] = useState<DefaultSkillEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [action, setAction] = useState<SidebarAction>(null);
  const [actionName, setActionName] = useState('');

  const isSelectedBuiltin = selected ? builtins.includes(selected) : false;

  const loadList = async () => {
    const token = await getToken();
    if (!token) return;
    const [skillsRes, defaultsRes] = await Promise.all([
      apiFetch('/api/skills', token),
      apiFetch('/api/skills-defaults', token),
    ]);
    const data: { skills: string[]; builtins: string[] } = await skillsRes.json();
    const defs: DefaultSkillEntry[] = await defaultsRes.json();
    setSkills(data.skills);
    setBuiltins(data.builtins);
    setDefaults(defs);
    onSkillsChange?.(data.skills);
  };

  const loadSkill = async (name: string) => {
    const token = await getToken();
    if (!token) return;
    const res = await apiFetch(`/api/skills/${name}`, token);
    const skill = await res.json();
    setContent(skill.content);
    setSelected(name);
    setDirty(false);
  };

  const save = async () => {
    if (!selected || isSelectedBuiltin) return;
    const token = await getToken();
    if (!token) return;
    await apiFetch(`/api/skills/${selected}`, token, { method: 'PUT', body: JSON.stringify({ content }) });
    setDirty(false);
  };

  const submitAction = async () => {
    const name = actionName.trim().replace(/\s+/g, '-');
    if (!name) return;
    const token = await getToken();
    if (!token) return;

    if (action === 'create') {
      await apiFetch(`/api/skills/${name}`, token, { method: 'PUT', body: JSON.stringify({ content: '' }) });
      await loadList();
      await loadSkill(name);
    } else if (action === 'duplicate' && selected) {
      const res = await apiFetch(`/api/skills/${selected}/duplicate`, token, { method: 'POST', body: JSON.stringify({ newName: name }) });
      if (!res.ok) return;
      await loadList();
      await loadSkill(name);
    } else if (action === 'rename' && selected) {
      const res = await apiFetch(`/api/skills/${selected}/rename`, token, { method: 'POST', body: JSON.stringify({ newName: name }) });
      if (!res.ok) return;
      await loadList();
      await loadSkill(name);
    }

    setAction(null);
    setActionName('');
  };

  const remove = async (name: string) => {
    const token = await getToken();
    if (!token) return;
    const res = await apiFetch(`/api/skills/${name}`, token, { method: 'DELETE' });
    if (!res.ok) return;
    if (selected === name) { setSelected(null); setContent(''); }
    await loadList();
  };

  const toggleDefault = async (name: string) => {
    const token = await getToken();
    if (!token) return;
    const next = isDefault(defaults, name)
      ? defaults.filter((d) => entryName(d) !== name)
      : [...defaults, name];
    await apiFetch('/api/skills-defaults', token, { method: 'PUT', body: JSON.stringify(next) });
    setDefaults(next);
  };


  const startAction = (type: SidebarAction) => {
    setAction(type);
    setActionName(type === 'rename' && selected ? selected : type === 'duplicate' && selected ? `${selected}-copy` : '');
  };

  const cancelAction = () => { setAction(null); setActionName(''); };

  useEffect(() => { if (open) loadList(); }, [open]);

  const actionPlaceholder = action === 'create' ? 'skill-name' : action === 'rename' ? 'new-name' : 'copy-name';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="ghost" size="icon" title="Skills" className="h-8 w-8">
            <BookOpen className="w-4 h-4" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-[95vw] sm:max-w-2xl h-[70dvh] sm:h-[520px] flex flex-col gap-0 p-0">
        <DialogHeader className="px-4 pt-4 pb-2 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="w-4 h-4" /> Skills
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col sm:flex-row flex-1 overflow-hidden">
          {/* Sidebar */}
          <div className={`sm:w-52 border-r flex flex-col shrink-0 ${selected ? 'hidden sm:flex' : 'flex'}`}>
            <div className="flex-1 overflow-y-auto py-1">
              {skills.map((s) => (
                <div
                  key={s}
                  className={`group flex items-center gap-1.5 px-3 py-1.5 cursor-pointer text-sm hover:bg-accent transition-colors ${selected === s ? 'bg-accent font-medium' : ''}`}
                  onClick={() => loadSkill(s)}
                >
                  <button
                    className={`shrink-0 transition-colors ${isDefault(defaults, s) ? 'text-amber-500' : 'text-muted-foreground/30 hover:text-amber-400'}`}
                    onClick={(e) => { e.stopPropagation(); toggleDefault(s); }}
                    title={isDefault(defaults, s) ? 'Remove from defaults' : 'Set as default (always active)'}
                  >
                    <Star className={`w-3 h-3 ${isDefault(defaults, s) ? 'fill-current' : ''}`} />
                  </button>
                  <span className="truncate flex-1">@{s}</span>
                  {builtins.includes(s) && (
                    <span title="Built-in (read-only)"><Lock className="w-2.5 h-2.5 text-muted-foreground/40 shrink-0" /></span>
                  )}
                  {!builtins.includes(s) && (
                    <button
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity shrink-0"
                      onClick={(e) => { e.stopPropagation(); remove(s); }}
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="border-t p-2">
              {action ? (
                <div className="flex gap-1">
                  <Input
                    value={actionName}
                    onChange={(e) => setActionName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitAction(); if (e.key === 'Escape') cancelAction(); }}
                    placeholder={actionPlaceholder}
                    className="h-7 text-xs"
                    autoFocus
                  />
                  <Button size="icon" className="h-7 w-7 shrink-0" onClick={submitAction}><Check className="w-3 h-3" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={cancelAction}><X className="w-3 h-3" /></Button>
                </div>
              ) : (
                <Button variant="outline" size="sm" className="w-full h-7 text-xs" onClick={() => startAction('create')}>
                  <Plus className="w-3 h-3 mr-1" /> New skill
                </Button>
              )}
            </div>
          </div>

          {/* Editor */}
          <div className={`flex-1 flex flex-col overflow-hidden ${!selected ? 'hidden sm:flex' : ''}`}>
            {selected ? (
              <>
                <div className="flex items-center justify-between px-3 py-2 border-b text-sm shrink-0">
                  <div className="flex items-center gap-0.5 font-medium">
                    <button className="sm:hidden mr-1.5 text-muted-foreground" onClick={() => { setSelected(null); setContent(''); setDirty(false); }}><ArrowLeft className="w-4 h-4" /></button>
                    <span className="text-muted-foreground">@</span>
                    <span>{selected}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isSelectedBuiltin && (
                      <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-medium flex items-center gap-0.5">
                        <Lock className="w-2.5 h-2.5" /> read-only
                      </span>
                    )}
                    {isDefault(defaults, selected) && (
                      <>
                        <span className="text-[10px] text-amber-600 bg-amber-50 dark:bg-amber-950/50 dark:text-amber-400 px-1.5 py-0.5 rounded font-medium">
                          default
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${isCapped(findEntry(defaults, selected)!) ? 'text-blue-600 bg-blue-50 dark:bg-blue-950/50 dark:text-blue-400' : 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/50 dark:text-emerald-400'}`}>
                          {isCapped(findEntry(defaults, selected)!) ? 'capped' : 'full'}
                        </span>
                      </>
                    )}
                    <Button
                      variant="ghost" size="sm" className="h-6 text-xs px-1.5"
                      onClick={() => startAction('duplicate')}
                      title="Duplicate"
                    >
                      <Copy className="w-3 h-3" />
                    </Button>
                    {!isSelectedBuiltin && (
                      <Button
                        variant="ghost" size="sm" className="h-6 text-xs px-1.5"
                        onClick={() => startAction('rename')}
                        title="Rename"
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                    )}
                    {dirty && !isSelectedBuiltin && (
                      <Button size="sm" className="h-6 text-xs" onClick={save}>
                        <Check className="w-3 h-3 mr-1" /> Save
                      </Button>
                    )}
                  </div>
                </div>
                <Textarea
                  value={content}
                  onChange={(e) => { if (!isSelectedBuiltin) { setContent(e.target.value); setDirty(true); } }}
                  readOnly={isSelectedBuiltin}
                  className={`flex-1 resize-none rounded-none border-0 font-mono text-xs focus-visible:ring-0 ${isSelectedBuiltin ? 'opacity-70 cursor-default' : ''}`}
                  placeholder="Write the skill instructions here…"
                />
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground text-sm gap-1">
                <p>Select or create a skill</p>
                <p className="text-xs"><Star className="w-3 h-3 inline fill-amber-500 text-amber-500" /> = injected in every conversation</p>
                <p className="text-xs"><Lock className="w-3 h-3 inline" /> = built-in, duplicate to customize</p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
