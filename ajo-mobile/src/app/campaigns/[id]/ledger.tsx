import { useLocalSearchParams } from 'expo-router';
import { LedgerView } from '../../../components/LedgerView';

export default function CampaignLedger() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <LedgerView kind="campaign" id={id} />;
}
