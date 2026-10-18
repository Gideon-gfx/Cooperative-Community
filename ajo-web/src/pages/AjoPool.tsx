import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { api, errMsg, naira, uploadFile } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Loading, Modal, PageShell, ProgressBar, StatusBadge } from '../components/ui';

interface Slot {
  id: string; payoutOrder: number; recipientId: string; recipientName: string; payoutDate: string; status: string;
  contributionsCount: number; verifiedCount: number; receiptUrl: string | null; netPayout: string;
}
interface MyContribution { id: string; scheduleId: string; amount: string; status: string; reportedPaid: boolean; dueAt: string }
interface PoolData {
  pool: { id: string; title: string; amountPerMember: string; cycleFrequency: string; status: string; isCollector: boolean; group: { id: string; name: string } };
  schedule: Slot[];
  myContributions: MyContribution[];
}
interface ContributionRow { id: string; contributorName: string; amount: string; status: string; reportedPaid: boolean; proofUrl: string | null; dueAt: string }

function CollectorPanel({ scheduleId, poolId }: { scheduleId: string; poolId: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['contribs', scheduleId],
    queryFn: async () => (await api.get<{ contributions: ContributionRow[] }>(`/ajo/schedules/${scheduleId}/contributions`)).data.contributions,
  });
  const verify = useMutation({
    mutationFn: (id: string) => api.patch(`/ajo/contributions/${id}/verify`),
    onSuccess: (res) => {
      toast.success(res.data.payoutTriggered ? (res.data.payoutError ? `Verified. Payout not sent: ${res.data.payoutError}` : 'Verified — payout sent!') : 'Contribution verified');
      qc.invalidateQueries({ queryKey: ['contribs', scheduleId] });
      qc.invalidateQueries({ queryKey: ['ajo', poolId] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <ul className="mt-3 divide-y rounded-xl bg-gray-50">
      {data?.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
          <span>{c.contributorName} · {naira(c.amount)}</span>
          <span className="flex items-center gap-2">
            {c.proofUrl && <a className="text-primary underline" href={c.proofUrl} target="_blank" rel="noreferrer">Proof</a>}
            <StatusBadge status={c.status === 'PENDING' && c.reportedPaid ? 'PROCESSING' : c.status} />
            {c.reportedPaid && c.status !== 'VERIFIED' && (
              <button className="btn-primary py-2" disabled={verify.isPending} onClick={() => verify.mutate(c.id)}>Verify</button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RecordModal({ contribution, onClose, poolId }: { contribution: MyContribution; onClose: () => void; poolId: string }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const record = useMutation({
    mutationFn: async () => {
      const proofUrl = file ? await uploadFile(file) : undefined;
      return api.post('/ajo/contributions/record', { scheduleId: contribution.scheduleId, proofUrl });
    },
    onSuccess: () => { toast.success('Recorded. Your Collector will verify it.'); qc.invalidateQueries({ queryKey: ['ajo', poolId] }); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Modal title="Record my contribution" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block font-semibold">Amount</label>
          <input className="input bg-gray-100 text-xl font-bold" readOnly value={naira(contribution.amount)} />
        </div>
        <div>
          <label className="mb-1 block font-semibold" htmlFor="proof">Proof of payment (optional)</label>
          <input id="proof" type="file" accept="image/*,application/pdf" className="block w-full min-h-tap" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <button className="btn-primary w-full" disabled={record.isPending} onClick={() => record.mutate()}>I have paid</button>
      </div>
    </Modal>
  );
}

export default function AjoPool() {
  const { poolId } = useParams();
  const { user } = useAuth();
  const [recording, setRecording] = useState<MyContribution | null>(null);
  const [openSlot, setOpenSlot] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['ajo', poolId],
    queryFn: async () => (await api.get<PoolData>(`/ajo/pools/${poolId}`)).data,
  });
  if (isLoading || !data) return <Loading />;

  const { pool, schedule, myContributions } = data;
  const current = schedule.find((s) => s.status !== 'COMPLETED');
  const nextToPay = myContributions.filter((c) => !c.reportedPaid && c.status !== 'VERIFIED').sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];

  return (
    <PageShell back={<Link to={`/groups/${pool.group.id}`} className="mb-3 inline-block underline">← {pool.group.name}</Link>}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>{pool.title}</h1>
          <p className="text-gray-600">{naira(pool.amountPerMember)} · {pool.cycleFrequency.toLowerCase()}</p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={pool.status} />
          {nextToPay && <button className="btn-accent" onClick={() => setRecording(nextToPay)}>Record My Contribution</button>}
        </div>
      </div>

      <ol className="space-y-3">
        {schedule.map((s) => {
          const yourTurn = current?.id === s.id && s.recipientId === user?.id;
          return (
            <li key={s.id} className={`card ${yourTurn ? 'bg-accent-light ring-2 ring-accent' : ''}`}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-xl font-bold text-white">{s.payoutOrder}</span>
                <div className="flex-1">
                  <p className="text-lg font-bold">
                    {s.recipientName} {yourTurn && <span className="badge ml-2 bg-accent text-gray-900">YOUR TURN</span>}
                  </p>
                  <p className="text-gray-600">{format(new Date(s.payoutDate), 'EEE, d MMM yyyy')}</p>
                </div>
                <StatusBadge status={s.status} />
              </div>
              <div className="mt-3">
                <div className="mb-1 flex justify-between text-sm"><span>Verified contributions</span><span>{s.verifiedCount}/{s.contributionsCount}</span></div>
                <ProgressBar value={s.verifiedCount} max={s.contributionsCount} />
              </div>
              {s.receiptUrl && <a className="mt-3 inline-block font-semibold text-primary underline" href={s.receiptUrl} target="_blank" rel="noreferrer">Download receipt</a>}
              {pool.isCollector && s.status !== 'COMPLETED' && (
                <>
                  <button className="btn-outline mt-3" onClick={() => setOpenSlot(openSlot === s.id ? null : s.id)}>
                    {openSlot === s.id ? 'Hide contributions' : 'Review contributions'}
                  </button>
                  {openSlot === s.id && <CollectorPanel scheduleId={s.id} poolId={pool.id} />}
                </>
              )}
            </li>
          );
        })}
      </ol>
      {recording && <RecordModal contribution={recording} poolId={pool.id} onClose={() => setRecording(null)} />}
    </PageShell>
  );
}
