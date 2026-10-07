/** Общие доменные типы. Совпадают по форме с контрактом docs/ws-protocol.md. */

export type Side = 'buy' | 'sell';

export interface Merchant {
  id: string;
  name: string;
  orders: number;
  completion: number; // 0..1
  rating: number; // 0..5
  verified: boolean;
  pro: boolean;
  avgReleaseMin: number;
  online: boolean;
  blocked: boolean;
}

export interface Offer {
  id: string; // "<exchange>:<venueId>"
  exchange: string;
  side: Side;
  asset: string;
  fiat: string;
  price: number;
  available: number; // в активе
  min: number; // лимиты сделки, в фиате
  max: number;
  methods: string[];
  merchant: Merchant;
  kycRequired: number; // 0..3
  terms: string;
  ts: number;
}

export type DealStatus = 'created' | 'paid' | 'released' | 'done' | 'cancelled' | 'disputed';

export interface Deal {
  id: string;
  ref: string;
  userId: string;
  offerId: string;
  exchange: string;
  side: Side;
  asset: string;
  fiat: string;
  price: number;
  amountAsset: number; // сколько актива
  volumeUsdt: number;
  fiatTotal: number;
  method: string;
  cardId: string | null;
  status: DealStatus;
  idemKey: string;
  createdAt: number;
  updatedAt: number;
}

export type KycStatus = 'none' | 'pending' | 'approved' | 'rejected';

export interface KycState {
  status: KycStatus;
  level: number; // 0..3
  pendingLevel: number | null;
  submittedAt: number | null;
  reviewedAt: number | null;
  rejectReason: string | null;
}

export type PlanId = 'trial' | 'week' | 'month' | 'quarter';

export interface Subscription {
  plan: PlanId | null;
  since: number | null;
  until: number | null;
  trialUsed: boolean;
}

export interface Card {
  id: string;
  label: string;
  bank: string;
  last4: string;
  balance: number;
  currency: string;
  active: boolean;
}

export interface User {
  id: string; // "u_<telegramId>"
  tgId: string;
  name: string;
  handle: string;
  createdAt: number;
}
