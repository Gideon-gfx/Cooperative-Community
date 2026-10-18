import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, Mic, Paperclip, Send } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errMsg, naira, uploadFile } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Loading, STATUS_EMOJI, StatusBadge } from '../components/ui';

interface PollOption { id: string; label: string; votes: number }
interface Poll { id: string; title: string; status: string; options: PollOption[]; totalVotes: number; myVoteOptionId: string | null; winner: PollOption | null }
interface Receipt { scheduleId: string; poolTitle: string; recipientName: string; totalCollected: string; platformFee: string; collectorFee: string; netPayout: string; receiptUrl: string | null }
interface Message {
  id: string; messageType: 'TEXT' | 'AUDIO' | 'RECEIPT' | 'POLL' | 'SYSTEM'; content: string | null; audioUrl: string | null;
  createdAt: string; sender: { id: string; fullName: string } | null; receipt?: Receipt | null; poll?: Poll | null;
}
interface GroupData {
  group: { id: string; name: string; adminId: string };
  members: { id: string; fullName: string; memberStatus: string; isAdmin: boolean }[];
  messages: Message[];
  ajoPools: { id: string; title: string }[];
  foodPools: { id: string }[];
}

function ReceiptCard({ r }: { r: Receipt }) {
  return (
    <div className="w-full max-w-sm rounded-2xl border-2 border-primary bg-white p-4">
      <div className="mb-2 flex items-center gap-2 font-bold text-primary"><CheckCircle2 /> Payout complete</div>
      <p className="text-sm text-gray-600">{r.poolTitle} · {r.recipientName}</p>
      <p className="my-2 text-3xl font-bold text-primary">{naira(r.netPayout)}</p>
      <dl className="space-y-1 text-sm">
        <div className="flex justify-between"><dt>Total collected</dt><dd>{naira(r.totalCollected)}</dd></div>
        <div className="flex justify-between"><dt>Platform fee</dt><dd>-{naira(r.platformFee)}</dd></div>
        <div className="flex justify-between"><dt>Collector fee</dt><dd>-{naira(r.collectorFee)}</dd></div>
      </dl>
      {r.receiptUrl && (
        <a href={r.receiptUrl} target="_blank" rel="noreferrer" className="btn-primary mt-3 w-full"><Download size={18} /> Download Receipt</a>
      )}
    </div>
  );
}

function PollCard({ poll, groupId }: { poll: Poll; groupId: string }) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState<string | null>(null);
  const vote = useMutation({
    mutationFn: () => api.post(`/groups/polls/${poll.id}/vote`, { pollOptionId: choice }),
    onSuccess: () => { toast.success('Vote recorded'); qc.invalidateQueries({ queryKey: ['group', groupId] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const open = poll.status === 'OPEN';
  const canVote = open && !poll.myVoteOptionId;
  return (
    <div className="w-full max-w-sm rounded-2xl border-2 border-accent bg-white p-4">
      <p className="mb-3 font-bold">📊 {poll.title}</p>
      <div className="space-y-2">
        {poll.options.map((o) => {
          const pct = poll.totalVotes ? Math.round((o.votes / poll.totalVotes) * 100) : 0;
          const selected = choice === o.id || poll.myVoteOptionId === o.id;
          return (
            <button
              key={o.id}
              disabled={!canVote}
              onClick={() => setChoice(o.id)}
              className={`relative min-h-tap w-full overflow-hidden rounded-xl border-2 px-3 py-2 text-left ${selected ? 'border-primary' : 'border-gray-200'}`}
            >
              <span className="absolute inset-y-0 left-0 bg-accent-light" style={{ width: `${pct}%` }} />
              <span className="relative flex justify-between"><span>{o.label}</span><span className="font-semibold">{pct}% ({o.votes})</span></span>
            </button>
          );
        })}
      </div>
      {canVote && <button className="btn-primary mt-3 w-full" disabled={!choice || vote.isPending} onClick={() => vote.mutate()}>Vote</button>}
      {poll.myVoteOptionId && open && <p className="mt-2 text-sm text-gray-600">You voted ✔</p>}
      {!open && poll.winner && <p className="mt-2 font-semibold text-primary">Winner: {poll.winner.label}</p>}
    </div>
  );
}

function Bubble({ m, mine, groupId }: { m: Message; mine: boolean; groupId: string }) {
  if (m.messageType === 'SYSTEM') {
    return <div className="mx-auto max-w-md rounded-full bg-gray-200 px-4 py-2 text-center text-sm text-gray-700">{m.content}</div>;
  }
  return (
    <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
      {!mine && <span className="mb-1 text-sm font-semibold text-primary">{m.sender?.fullName ?? 'ÀJỌ'}</span>}
      {m.messageType === 'RECEIPT' && m.receipt ? (
        <ReceiptCard r={m.receipt} />
      ) : m.messageType === 'POLL' && m.poll ? (
        <PollCard poll={m.poll} groupId={groupId} />
      ) : (
        <div className={`max-w-[85%] rounded-2xl px-4 py-2 ${mine ? 'bg-primary text-white' : 'bg-white ring-1 ring-gray-200'}`}>
          {m.messageType === 'AUDIO' ? (
            m.audioUrl ? <audio controls src={m.audioUrl} /> : <span className="flex items-center gap-2"><Mic size={18} /> Voice note</span>
          ) : /^https?:\/\/\S+$/.test(m.content ?? '') ? (
            <a href={m.content!} target="_blank" rel="noreferrer" className="underline">📎 Attachment</a>
          ) : (
            m.content
          )}
        </div>
      )}
      <span className="mt-1 text-xs text-gray-500">{new Date(m.createdAt).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}</span>
    </div>
  );
}

export default function GroupChat() {
  const { id } = useParams();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['group', id],
    queryFn: async () => (await api.get<GroupData>(`/groups/${id}`)).data,
    refetchInterval: 6000,
  });

  const send = useMutation({
    mutationFn: (content: string) => api.post(`/groups/${id}/messages`, { content, messageType: 'TEXT' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['group', id] }),
    onError: (e) => toast.error(errMsg(e)),
  });

  const messages = data ? [...data.messages].reverse() : [];
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  if (isLoading || !data) return <Loading />;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    send.mutate(text.trim());
    setText('');
  };
  const attach = async (file?: File) => {
    if (!file) return;
    try {
      send.mutate(await uploadFile(file));
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  return (
    <div className="mx-auto flex h-screen max-w-6xl flex-col md:flex-row">
      <section className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-center justify-between bg-primary px-4 py-3 text-white">
          <div>
            <Link to="/dashboard" className="text-sm text-white/80 underline">← Dashboard</Link>
            <h2 className="text-xl">{data.group.name}</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {data.ajoPools.map((p) => <Link key={p.id} to={`/ajo/${p.id}`} className="btn-accent min-h-tap py-2 text-sm">Àjọ: {p.title}</Link>)}
            {data.foodPools.map((p) => <Link key={p.id} to={`/food/${p.id}`} className="btn-accent min-h-tap py-2 text-sm">Food pool</Link>)}
          </div>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto bg-[#efeae2] p-4">
          {messages.map((m) => <Bubble key={m.id} m={m} groupId={data.group.id} mine={m.sender?.id === user?.id} />)}
          <div ref={endRef} />
        </div>

        <form onSubmit={submit} className="flex items-center gap-2 border-t bg-white p-3">
          <input ref={fileRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => attach(e.target.files?.[0])} />
          <button type="button" className="btn-outline px-3" aria-label="Attach receipt" onClick={() => fileRef.current?.click()}><Paperclip /></button>
          <input className="input flex-1" placeholder="Type a message" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn-primary" disabled={send.isPending}><Send size={18} /> Send</button>
        </form>
      </section>

      <aside className="w-full overflow-y-auto border-l bg-white p-4 md:w-72">
        <h3 className="mb-3">Members ({data.members.length})</h3>
        <ul className="space-y-2">
          {data.members.map((m) => (
            <li key={m.id} className="flex min-h-tap items-center justify-between gap-2">
              <span>{STATUS_EMOJI[m.memberStatus]} {m.fullName}{m.isAdmin && <em className="ml-1 text-sm text-gray-500">(Collector)</em>}</span>
              <StatusBadge status={m.memberStatus} />
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
