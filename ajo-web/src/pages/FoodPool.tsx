import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { differenceInSeconds } from 'date-fns';
import { Truck } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errMsg, naira, uploadFile } from '../api/client';
import { Loading, PageShell, ProgressBar, StatusBadge } from '../components/ui';

interface Tally { productId: string; name: string; supplier: string; unitPrice: number; votes: number }
interface Product { id: string; name: string; unitPrice: string; kgWeightPerUnit: number; supplier: { businessName: string; supplierType: string } }
interface PoolData {
  pool: {
    id: string; status: string; contributionAmt: string; targetMembers: number; currentMembers: number; totalFund: string;
    liveWindowEnd: string; communityHubAddr: string | null; transportFee: string; netFoodBudget: string;
    group: { id: string; name: string };
    winningProduct: { name: string; supplier: { businessName: string } } | null;
  };
  tallies: Tally[];
  isCollector: boolean;
  myMembership: { isPaidVerified: boolean; hasVoted: boolean } | null;
  members?: { id: string; fullName: string; proofOfPaymentUrl: string | null; isPaidVerified: boolean }[];
}

function Countdown({ end }: { end: string }) {
  const [secs, setSecs] = useState(() => differenceInSeconds(new Date(end), new Date()));
  useEffect(() => {
    const t = setInterval(() => setSecs(differenceInSeconds(new Date(end), new Date())), 1000);
    return () => clearInterval(t);
  }, [end]);
  if (secs <= 0) return <span className="font-bold text-warning">Window closed</span>;
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return <span className="font-mono font-bold">{h}h {m}m {s}s</span>;
}

export default function FoodPool() {
  const { poolId } = useParams();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [productId, setProductId] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['food', poolId] });

  const { data, isLoading } = useQuery({
    queryKey: ['food', poolId],
    queryFn: async () => (await api.get<PoolData>(`/ccgb/pools/${poolId}`)).data,
    refetchInterval: 10000,
  });
  const products = useQuery({
    queryKey: ['products'],
    queryFn: async () => (await api.get<{ products: Product[] }>('/ccgb/suppliers/products?availableOnly=true')).data.products,
  });

  const join = useMutation({
    mutationFn: async () => api.post('/ccgb/pools/join', { poolId, proofOfPaymentUrl: await uploadFile(file!) }),
    onSuccess: () => { toast.success('Joined! Waiting for payment verification.'); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const vote = useMutation({
    mutationFn: () => api.post('/ccgb/pools/vote', { poolId, productId }),
    onSuccess: () => { toast.success('Vote cast'); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const verify = useMutation({
    mutationFn: (id: string) => api.patch(`/ccgb/admin/members/${id}/verify-payment`),
    onSuccess: () => { toast.success('Payment verified'); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const lock = useMutation({
    mutationFn: () => api.post(`/ccgb/pools/${poolId}/lock`),
    onSuccess: () => { toast.success('Pool locked'); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (isLoading || !data) return <Loading />;
  const { pool, tallies, myMembership, isCollector } = data;
  const maxVotes = Math.max(1, ...tallies.map((t) => t.votes));
  const collecting = pool.status === 'COLLECTING';

  return (
    <PageShell back={<Link to={`/groups/${pool.group.id}`} className="mb-3 inline-block underline">← {pool.group.name}</Link>}>
      <div className="mb-5 flex items-center justify-between">
        <h1>Food Pool</h1>
        <StatusBadge status={pool.status} />
      </div>

      <section className="card mb-5 space-y-3">
        <div className="grid gap-4 sm:grid-cols-3">
          <div><p className="text-gray-600">Contribution</p><p className="text-2xl font-bold">{naira(pool.contributionAmt)}</p></div>
          <div><p className="text-gray-600">Members</p><p className="text-2xl font-bold">{pool.currentMembers} / {pool.targetMembers}</p></div>
          <div><p className="text-gray-600">Closes in</p><p className="text-2xl"><Countdown end={pool.liveWindowEnd} /></p></div>
        </div>
        <ProgressBar value={pool.currentMembers} max={pool.targetMembers} color="bg-accent" />
      </section>

      {pool.status === 'LOCKED' || pool.status === 'DISPATCHED' || pool.status === 'DELIVERED' ? (
        <section className="card border-2 border-accent bg-accent-light">
          <h2 className="mb-2">🏆 {pool.winningProduct?.name} won the vote</h2>
          <p>Supplier: {pool.winningProduct?.supplier.businessName}</p>
          <p>Food budget: <b>{naira(pool.netFoodBudget)}</b> (transport {naira(pool.transportFee)})</p>
          <p className="mt-2 flex items-center gap-2"><Truck size={20} /> Delivery: <StatusBadge status={pool.status} /></p>
          <p>Collection point: <b>{pool.communityHubAddr}</b></p>
        </section>
      ) : pool.status === 'DISSOLVED' ? (
        <p className="card text-warning">This pool was dissolved because it did not reach its target. Refunds have been processed.</p>
      ) : (
        <>
          {!myMembership && collecting && (
            <section className="card mb-5 space-y-3">
              <h3>Join this pool</h3>
              <p>Pay {naira(pool.contributionAmt)} to the co-op account, then upload your proof of payment.</p>
              <input type="file" accept="image/*,application/pdf" className="block min-h-tap w-full" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <button className="btn-primary" disabled={!file || join.isPending} onClick={() => join.mutate()}>Submit payment proof</button>
            </section>
          )}
          {myMembership && !myMembership.isPaidVerified && <p className="card mb-5">⏳ Payment submitted. Voting opens once your Collector verifies it.</p>}

          {myMembership?.isPaidVerified && (
            <section className="card mb-5 space-y-3">
              <h3>Vote for the food item</h3>
              {myMembership.hasVoted ? (
                <p className="font-semibold text-primary">✔ You have voted.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <select className="input flex-1" value={productId} onChange={(e) => setProductId(e.target.value)}>
                    <option value="">Select a product…</option>
                    {products.data?.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} — {naira(p.unitPrice)} · {p.kgWeightPerUnit}kg · {p.supplier.businessName} ({p.supplier.supplierType.replace('_', ' ').toLowerCase()})</option>
                    ))}
                  </select>
                  <button className="btn-primary" disabled={!productId || vote.isPending} onClick={() => vote.mutate()}>Cast Vote</button>
                </div>
              )}
            </section>
          )}
        </>
      )}

      <section className="card mb-5">
        <h3 className="mb-3">Live tally</h3>
        {tallies.length === 0 && <p className="text-gray-500">No votes yet.</p>}
        <div className="space-y-3">
          {tallies.map((t) => (
            <div key={t.productId}>
              <div className="mb-1 flex justify-between"><span>{t.name} <span className="text-sm text-gray-500">({t.supplier})</span></span><b>{t.votes}</b></div>
              <ProgressBar value={t.votes} max={maxVotes} color="bg-accent" />
            </div>
          ))}
        </div>
      </section>

      {isCollector && (
        <section className="card space-y-3">
          <h3>Collector tools</h3>
          {data.members?.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{m.fullName}</span>
              <span className="flex items-center gap-2">
                {m.proofOfPaymentUrl && <a className="text-primary underline" href={m.proofOfPaymentUrl} target="_blank" rel="noreferrer">Proof</a>}
                {m.isPaidVerified ? <StatusBadge status="VERIFIED" /> : <button className="btn-primary py-2" onClick={() => verify.mutate(m.id)}>Verify payment</button>}
              </span>
            </div>
          ))}
          {collecting && <button className="btn-accent w-full" disabled={lock.isPending} onClick={() => lock.mutate()}>Lock pool & place order</button>}
        </section>
      )}
    </PageShell>
  );
}
