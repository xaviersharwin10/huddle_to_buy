type Entry = { peers: Set<string>; firstSeen: number; lastSeen: number };

export type ObserveResult = {
  count: number;
  thresholdReached: boolean;
};

export class IntentObserver {
  private window = new Map<string, Entry>();

  constructor(
    private readonly windowMs = 24 * 60 * 60 * 1000,
    private readonly k = 3,
  ) {}

  observe(commitment: string, peerId: string): ObserveResult {
    const now = Date.now();
    this.gc(now);
    let e = this.window.get(commitment);
    if (!e) {
      e = { peers: new Set(), firstSeen: now, lastSeen: now };
      this.window.set(commitment, e);
    }
    e.peers.add(peerId);
    e.lastSeen = now;
    return { count: e.peers.size, thresholdReached: e.peers.size >= this.k };
  }

  peersFor(commitment: string): string[] {
    return [...(this.window.get(commitment)?.peers ?? [])];
  }

  count(commitment: string): number {
    return this.window.get(commitment)?.peers.size ?? 0;
  }

  snapshot() {
    return [...this.window.entries()].map(([commitment, e]) => ({
      commitment,
      peers: [...e.peers],
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
    }));
  }

  private gc(now: number) {
    for (const [c, e] of this.window) {
      if (now - e.lastSeen > this.windowMs) this.window.delete(c);
    }
  }
}
