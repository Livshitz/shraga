import { useState, useImperativeHandle, forwardRef } from 'react';
import { Clock } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';
import { useSchedules } from '@/hooks/useSchedules';
import { useAuth } from '@/hooks/useAuth';
import { ScheduleList } from './schedules/ScheduleList';
import { ScheduleEditor } from './schedules/ScheduleEditor';
import type { Schedule } from '@/lib/schedule-types';

export interface SchedulesManagerHandle {
  open: () => void;
}

interface Props {
  getToken: () => Promise<string | null>;
  onOpenSession: (sessionId: string) => void;
  refreshKey?: number;
  runningIds?: Set<string>;
  skills?: string[];
  workspaceFiles?: string[];
  trigger?: React.ReactNode;
}

export const SchedulesManager = forwardRef<SchedulesManagerHandle, Props>(function SchedulesManager({ getToken, onOpenSession, refreshKey = 0, runningIds = new Set(), skills = [], workspaceFiles = [], trigger }, ref) {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const { schedules, serverRunningIds, create, update, remove, toggle, runNow, cancelRun } = useSchedules(getToken, open, refreshKey);

  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingRunIds, setPendingRunIds] = useState<Set<string>>(new Set());

  const closeEditor = () => { setEditing(null); setCreating(false); };
  const handleRunNow = async (id: string, override?: string) => {
    setPendingRunIds((prev) => new Set(prev).add(id));
    try {
      return await runNow(id, override);
    } finally {
      setTimeout(() => {
        setPendingRunIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 1500);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) closeEditor(); }}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Scheduled Tasks">
            <Clock className="w-4 h-4" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-[95vw] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{creating ? 'New Schedule' : editing ? `Edit: ${editing.name}` : 'Scheduled Tasks'}</DialogTitle>
        </DialogHeader>

        {creating ? (
          <ScheduleEditor
            key="__new__"
            onSave={async (s) => { await create(s); closeEditor(); }}
            onCancel={closeEditor}
            skills={skills}
            workspaceFiles={workspaceFiles}
          />
        ) : editing ? (
          <ScheduleEditor
            key={editing.id}
            initial={editing}
            onSave={async (s) => { await update(editing.id, s); closeEditor(); }}
            onCancel={closeEditor}
            skills={skills}
            workspaceFiles={workspaceFiles}
          />
        ) : (
          <ScheduleList
            schedules={schedules}
            currentUserUid={user?.uid}
            onCreate={() => setCreating(true)}
            onEdit={(s) => setEditing(s)}
            onDelete={(id) => { if (confirm('Delete this schedule?')) remove(id); }}
            onToggle={toggle}
            onRunNow={handleRunNow}
            onCancel={cancelRun}
            runningIds={new Set([...runningIds, ...serverRunningIds, ...pendingRunIds])}
            onOpenRun={(sid) => { setOpen(false); onOpenSession(sid); }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
});
