import { X, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToastItem } from '@/hooks/useUnread';

interface Props {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
  onOpen: (sessionId: string) => void;
}

export function ToastStack({ toasts, onDismiss, onOpen }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col-reverse gap-2 max-w-sm w-full pointer-events-none">
      {toasts.map((toast, i) => (
        <div
          key={toast.id}
          className={cn(
            'pointer-events-auto bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded-lg shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.5)] p-3 pr-7 cursor-pointer relative',
            'transform transition-all duration-300 ease-out',
            'hover:bg-zinc-50 dark:hover:bg-zinc-700 group',
            i === 0 ? 'animate-in slide-in-from-bottom-2 fade-in' : '',
          )}
          onClick={() => {
            onOpen(toast.sessionId);
            onDismiss(toast.id);
          }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(toast.id);
            }}
            className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-muted rounded"
          >
            <X className="w-3 h-3 text-muted-foreground" />
          </button>
          <div className="flex items-start gap-2.5">
            <MessageSquare className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-foreground truncate">
                {toast.title || `Session ${toast.sessionId.slice(0, 8)}`}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                {toast.preview}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
