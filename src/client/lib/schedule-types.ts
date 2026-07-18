export type Trigger =
  | { kind: 'once'; at: number }
  | { kind: 'interval'; everyMs: number }
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'event'; source: string; match?: Record<string, string> };

export type Task =
  | { kind: 'prompt'; prompt: string; model?: string }
  | { kind: 'bash'; command: string; model?: string }
  | { kind: 'job'; command: string };

export type Scope = 'system' | 'user';

export interface ScheduleRunSummary {
  at: number;
  sessionId: string;
  status: 'running' | 'ok' | 'error' | 'aborted';
  error?: string;
}

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  task: Task;
  scope: Scope;
  createdBy: { uid: string; email: string };
  createdAt: number;
  updatedAt: number;
  nextRun?: number;
  lastRun?: ScheduleRunSummary;
  runCount: number;
}
