/**
 * Внутришинная доставка пользовательских пушей (статусы сделок, KYC) до
 * подключённых WS-сессий. In-process pub/sub по userId. При нескольких
 * инстансах заменяется на Redis Pub/Sub — тот же интерфейс.
 */
export type UserPush =
  | { type: 'deal'; data: { dealId: string; ref: string; status: string; at: number } }
  | { type: 'kyc'; data: { status: string; level: number; reviewedAt: number; rejectReason: string | null } };

type Handler = (ev: UserPush) => void;

export class UserEventBus {
  private readonly subs = new Map<string, Set<Handler>>();

  on(userId: string, fn: Handler): () => void {
    let set = this.subs.get(userId);
    if (!set) {
      set = new Set();
      this.subs.set(userId, set);
    }
    set.add(fn);
    return () => {
      const s = this.subs.get(userId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.subs.delete(userId);
    };
  }

  emit(userId: string, ev: UserPush): void {
    const set = this.subs.get(userId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(ev);
      } catch {
        /* изоляция: сбой одного получателя не роняет остальных */
      }
    }
  }
}
