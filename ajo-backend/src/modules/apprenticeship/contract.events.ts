import { EventEmitter } from 'events';

// Things that change a person's standing (a conduct log, a milestone, a payment, a graduation) announce themselves here.
// The trust module listens and recomputes the affected scores, so scores are refreshed on events and never on every read.
export const contractEvents = new EventEmitter();
export const emitContractChanged = (contractId: string) => {
  try { contractEvents.emit('changed', contractId); } catch { /* a listener must never break the action that announced it */ }
};
