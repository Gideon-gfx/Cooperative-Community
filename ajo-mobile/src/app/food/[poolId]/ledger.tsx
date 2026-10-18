import { useLocalSearchParams } from 'expo-router';
import { LedgerView } from '../../../components/LedgerView';

export default function FoodLedger() {
  const { poolId } = useLocalSearchParams<{ poolId: string }>();
  return <LedgerView kind="food" id={poolId} />;
}
