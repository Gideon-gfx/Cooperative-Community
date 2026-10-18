import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Bell, Coins, LogOut, ShoppingBasket, Users } from 'lucide-react';
import { api, naira } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Loading, PageShell, StatusBadge } from '../components/ui';

interface AjoCard { id: string; title: string; groupName: string; status: string; amountPerMember: string; myCollectionDate: string | null; nextDueAt: string | null }
interface Notice { contributionId: string; poolId: string; poolTitle: string; recipientName: string; amount: string; dueAt: string; kind: 'DUE' | 'MISSED' }
interface FoodCard { id: string; status: string; contributionAmt: string; currentMembers: number; targetMembers: number; liveWindowEnd: string; group: { name: string }; winningProduct: { name: string } | null }

const fmt = (d: string | null) => (d ? format(new Date(d), 'd MMM yyyy') : '—');

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState<'ajo' | 'food'>('ajo');
  const [showBell, setShowBell] = useState(false);

  const ajo = useQuery({ queryKey: ['my-ajo'], queryFn: async () => (await api.get<{ pools: AjoCard[]; notifications: Notice[] }>('/ajo/my-pools')).data });
  const food = useQuery({ queryKey: ['my-food'], queryFn: async () => (await api.get<{ pools: FoodCard[] }>('/ccgb/my-pools')).data.pools });
  const groups = useQuery({ queryKey: ['my-groups'], queryFn: async () => (await api.get<{ groups: { id: string; name: string }[] }>('/groups/mine')).data.groups });
  const profile = useQuery({ queryKey: ['profile'], queryFn: async () => (await api.get<{ user: { walletBalance: string } }>('/auth/profile')).data.user });

  const notices = ajo.data?.notifications ?? [];

  return (
    <PageShell>
      <header className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1>Hello, {user?.fullName.split(' ')[0]}</h1>
          <p className="text-gray-600">Wallet: <b className="text-primary">{naira(profile.data?.walletBalance ?? 0)}</b> · <StatusBadge status={user?.memberStatus ?? 'CLEAN'} /></p>
        </div>
        <div className="relative flex gap-2">
          <button className="btn-outline relative" onClick={() => setShowBell((v) => !v)} aria-label="Notifications">
            <Bell />
            {notices.length > 0 && <span className="absolute -right-1 -top-1 flex h-6 min-w-6 items-center justify-center rounded-full bg-warning px-1 text-sm text-white">{notices.length}</span>}
          </button>
          <button className="btn-outline" onClick={logout} aria-label="Log out"><LogOut /></button>
          {showBell && (
            <div className="absolute right-0 top-14 z-20 w-80 max-w-[90vw] rounded-2xl bg-white p-3 shadow-xl ring-1 ring-gray-200">
              {notices.length === 0 && <p className="p-2 text-gray-500">You're all caught up.</p>}
              {notices.map((n) => (
                <Link key={n.contributionId} to={`/ajo/${n.poolId}`} className={`block min-h-tap rounded-xl p-3 ${n.kind === 'MISSED' ? 'bg-red-50 text-warning' : 'hover:bg-gray-50'}`}>
                  <b>{n.kind === 'MISSED' ? '⚠️ Missed payment' : 'Contribution due'}</b>
                  <br />{naira(n.amount)} for {n.recipientName} · {n.poolTitle} · {fmt(n.dueAt)}
                </Link>
              ))}
            </div>
          )}
        </div>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3">
        <button onClick={() => setTab('ajo')} className={`card flex min-h-tap items-center justify-center gap-2 text-lg font-bold ${tab === 'ajo' ? 'bg-primary text-white' : ''}`}><Coins /> My Àjọ Pools</button>
        <button onClick={() => setTab('food')} className={`card flex min-h-tap items-center justify-center gap-2 text-lg font-bold ${tab === 'food' ? 'bg-accent' : ''}`}><ShoppingBasket /> My Food Pools</button>
      </div>

      {(ajo.isLoading || food.isLoading) && <Loading />}

      {tab === 'ajo' && (
        <div className="grid gap-4 sm:grid-cols-2">
          {ajo.data?.pools.map((p) => (
            <Link key={p.id} to={`/ajo/${p.id}`} className="card block space-y-1 hover:ring-primary">
              <div className="flex items-center justify-between"><h3>{p.title}</h3><StatusBadge status={p.status} /></div>
              <p className="text-gray-600">{p.groupName} · {naira(p.amountPerMember)}</p>
              <p>Next due: <b>{fmt(p.nextDueAt)}</b></p>
              <p>You collect: <b>{fmt(p.myCollectionDate)}</b></p>
            </Link>
          ))}
          {ajo.data?.pools.length === 0 && <p className="text-gray-500">You are not in any Àjọ pool yet.</p>}
        </div>
      )}

      {tab === 'food' && (
        <div className="grid gap-4 sm:grid-cols-2">
          {food.data?.map((p) => (
            <Link key={p.id} to={`/food/${p.id}`} className="card block space-y-1">
              <div className="flex items-center justify-between"><h3>{p.group.name}</h3><StatusBadge status={p.status} /></div>
              <p>{naira(p.contributionAmt)} · {p.currentMembers}/{p.targetMembers} members</p>
              <p>{p.winningProduct ? <>Winner: <b>{p.winningProduct.name}</b></> : <>Closes: <b>{fmt(p.liveWindowEnd)}</b></>}</p>
            </Link>
          ))}
          {food.data?.length === 0 && <p className="text-gray-500">You are not in any food pool yet.</p>}
        </div>
      )}

      <h2 className="mb-3 mt-10 flex items-center gap-2"><Users /> My groups</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {groups.data?.map((g) => <Link key={g.id} to={`/groups/${g.id}`} className="card flex min-h-tap items-center font-semibold">{g.name}</Link>)}
        {groups.data?.length === 0 && <p className="text-gray-500">Ask your Baba Àlàjọ to invite your phone number.</p>}
      </div>
    </PageShell>
  );
}
