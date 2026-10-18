import { Text, View } from 'react-native';
import { colors, fonts } from '../theme';
import { ProgressBar } from './ui';

export type CampaignKind = 'ASO_EBI' | 'HELP' | 'OTHER';

export interface Campaign {
  id: string; kind: CampaignKind; occasion: string; occasionLabel?: string | null; title: string; description?: string | null; eventDate?: string | null; venue?: string | null;
  partAmount?: number | null; targetAmount?: number | null; targetPeople?: number | null; recipientName?: string | null; recipientNote?: string | null;
  status: 'OPEN' | 'CLOSED' | 'COMPLETED' | 'CANCELLED'; closesAt?: string | null; deliveredAt?: string | null; deliveredAmount?: number | null;
  deliveryNote?: string | null; recipientConfirmedAt?: string | null; groupName?: string; hostName?: string; currency: string; isHost: boolean;
  options: { id: string; label: string; note?: string | null }[];
}
export interface Progress { paidPeople: number; raised: number; foodPledges: number }

// Adire-style stripes from the brand motif, used as the card banner.
const STRIPES = [colors.clay, colors.gold, colors.zobo, colors.orange, colors.cream, colors.clay, colors.gold, colors.indigo, colors.orange, colors.zobo, colors.cream, colors.gold];
const HELP_STRIPES = [colors.indigo, colors.cream, colors.indigo, colors.gold, colors.indigo, colors.cream, colors.zobo, colors.indigo, colors.cream, colors.gold, colors.indigo, colors.cream];

const OTHER_STRIPES = [colors.green, colors.cream, colors.gold, colors.green, colors.cream, colors.orange, colors.green, colors.cream, colors.gold, colors.green, colors.cream, colors.orange];

export function Banner({ label, kind }: { label: string; kind: CampaignKind }) {
  const palette = kind === 'ASO_EBI' ? STRIPES : kind === 'HELP' ? HELP_STRIPES : OTHER_STRIPES;
  return (
    <View style={{ height: 64, flexDirection: 'row', overflow: 'hidden', borderTopLeftRadius: 14, borderTopRightRadius: 14, justifyContent: 'center' }}>
      <View style={{ position: 'absolute', inset: 0, flexDirection: 'row' }}>
        {palette.map((c, i) => <View key={i} style={{ flex: 1, backgroundColor: c }} />)}
      </View>
      <View style={{ alignSelf: 'flex-end', marginBottom: 10, marginLeft: 12, backgroundColor: colors.cocoaNight, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4, position: 'absolute', left: 0 }}>
        <Text style={{ color: colors.gold, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 1 }}>{label}</Text>
      </View>
    </View>
  );
}

/** Banner text in the user's language. A host-typed name for "Other" is shown as typed. */
export function bannerLabel(c: Pick<Campaign, 'kind' | 'occasion' | 'occasionLabel'>, t: (k: string) => string): string {
  const name = c.occasion === 'OTHER' && c.occasionLabel ? c.occasionLabel : t(`occ_${c.occasion}`);
  return (c.kind === 'ASO_EBI' ? `${name} · ${t('asoTag')}` : name).toUpperCase();
}

/** "28 of 40 friends paid · 70%" for matching outfits; "₦X of ₦Y" for help with a goal. */
export function ProgressLine({ c, p }: { c: Campaign; p: Progress }) {
  const money = (n: number) => `${c.currency === 'NGN' ? '₦' : c.currency + ' '}${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
  const byPeople = c.kind === 'ASO_EBI' || (!c.targetAmount && !!c.targetPeople);
  const max = byPeople ? c.targetPeople ?? 0 : c.targetAmount ?? 0;
  const value = byPeople ? p.paidPeople : p.raised;
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ fontFamily: fonts.bodyBold, fontSize: 15, color: colors.text }}>
          {byPeople ? (max ? `${p.paidPeople} of ${max} friends paid` : `${p.paidPeople} friends paid`) : max ? `${money(p.raised)} of ${money(max)}` : `${money(p.raised)} raised`}
        </Text>
        {max > 0 && <Text style={{ fontFamily: fonts.bodyBold, fontSize: 15, color: colors.text }}>{pct}%</Text>}
      </View>
      {max > 0 && <ProgressBar value={value} max={max} color={colors.zobo} />}
    </View>
  );
}
