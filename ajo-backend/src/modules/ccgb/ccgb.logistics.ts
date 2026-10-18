import { PrismaClient, User } from '@prisma/client';
import { config } from '../../lib/config';

const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** BASE + distanceKm * RATE, rounded up to the nearest ₦100. */
export function calculateTransportFee(supplierLat: number, supplierLng: number, hubLat: number, hubLng: number): number {
  const km = haversineDistanceKm(supplierLat, supplierLng, hubLat, hubLng);
  const raw = config.transportBaseFee + km * config.transportRatePerKm;
  // toFixed guards against float noise (e.g. 17500.000000000004) pushing an exact value up a band
  return Math.ceil(Number(raw.toFixed(6)) / 100) * 100;
}

export async function findNearestActiveTransporter(hubLat: number, hubLng: number, prisma: PrismaClient): Promise<User | null> {
  const drivers = await prisma.user.findMany({
    where: { role: 'TRANSPORTER', locationLat: { not: null }, locationLng: { not: null } },
  });
  let best: User | null = null;
  let bestKm = Infinity;
  for (const d of drivers) {
    const km = haversineDistanceKm(hubLat, hubLng, d.locationLat!, d.locationLng!);
    if (km < bestKm) {
      best = d;
      bestKm = km;
    }
  }
  return best;
}
