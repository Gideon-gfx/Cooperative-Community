import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

const STATUS_STYLES: Record<string, string> = {
  CLEAN: 'bg-green-100 text-green-800',
  WARNED: 'bg-yellow-100 text-yellow-800',
  DEFAULTER: 'bg-red-100 text-warning',
  COMPLETED: 'bg-green-100 text-green-800',
  VERIFIED: 'bg-green-100 text-green-800',
  DELIVERED: 'bg-green-100 text-green-800',
  SCHEDULED: 'bg-gray-100 text-gray-700',
  PENDING: 'bg-yellow-100 text-yellow-800',
  PROCESSING: 'bg-blue-100 text-blue-800',
  COLLECTING: 'bg-blue-100 text-blue-800',
  LOCKED: 'bg-accent-light text-amber-800',
  DISPATCHED: 'bg-accent-light text-amber-800',
  ACTIVE: 'bg-green-100 text-green-800',
  MISSED: 'bg-red-100 text-warning',
  FAILED: 'bg-red-100 text-warning',
  DISSOLVED: 'bg-red-100 text-warning',
  LATE: 'bg-orange-100 text-orange-800',
};

export const STATUS_EMOJI: Record<string, string> = { CLEAN: '🟢', WARNED: '🟡', DEFAULTER: '🔴' };

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-700'}`}>{status}</span>;
}

export function ProgressBar({ value, max, color = 'bg-primary' }: { value: number; max: number; color?: string }) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div className="h-3 w-full overflow-hidden rounded-full bg-gray-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-6" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3>{title}</h3>
          <button className="btn min-w-tap p-2" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PageShell({ children, back }: { children: ReactNode; back?: ReactNode }) {
  return (
    <div className="mx-auto min-h-screen max-w-5xl px-4 py-6">
      {back}
      {children}
    </div>
  );
}

export function Loading() {
  return <p className="p-10 text-center text-gray-500">Loading…</p>;
}
