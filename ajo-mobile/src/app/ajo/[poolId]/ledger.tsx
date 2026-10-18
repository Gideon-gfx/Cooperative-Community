import { useLocalSearchParams } from 'expo-router';
import { LedgerView } from '../../../components/LedgerView';

export default function AjoLedger() {
  const { poolId } = useLocalSearchParams<{ poolId: string }>();
  return <LedgerView kind="ajo" id={poolId} />;
}
