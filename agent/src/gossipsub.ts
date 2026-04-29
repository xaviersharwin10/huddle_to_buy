import { Buffer } from "buffer";

export interface GossipConfig {
  D: number;
  D_low: number;
  D_high: number;
  D_gossip: number;
  heartbeat_interval: number; // milliseconds
  max_ihave_length: number;
}

export const DEFAULT_GOSSIP_CONFIG: GossipConfig = {
  D: 3,
  D_low: 2,
  D_high: 4,
  D_gossip: 1,
  heartbeat_interval: 1000,
  max_ihave_length: 5000,
};

export class GossipSub {
  public peers: Set<string> = new Set();
  public mesh: Map<string, Set<string>> = new Map();
  public subscriptions: Set<string> = new Set();

  private seen_msgs: Set<string> = new Set();
  private msg_cache: Map<string, any> = new Map();
  private _pending_iwant: Set<string> = new Set();

  private _last_heartbeat: number = Date.now();

  // Stats
  private _published: string[] = [];
  private _received: Set<string> = new Set();
  private _total_received: number = 0;
  private _hop_counts: Map<string, number> = new Map();

  constructor(
    public config: GossipConfig,
    public node_id: string,
    private send_fn: (dest: string, data: string) => Promise<void>,
    private on_message?: (topic: string, data: Buffer) => Promise<void>
  ) {}

  add_peer(peer_id: string) {
    this.peers.add(peer_id);
  }

  subscribe(topic: string) {
    this.subscriptions.add(topic);
    if (!this.mesh.has(topic)) {
      this.mesh.set(topic, new Set());
    }
  }

  private _gen_msg_id(): string {
    return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  }

  async publish(topic: string, data: Buffer): Promise<string> {
    const msg_id = this._gen_msg_id();
    this._published.push(msg_id);
    this.seen_msgs.add(msg_id);

    const msg = {
      type: "gossipsub",
      msg_type: "MESSAGE",
      topic: topic,
      msg_id: msg_id,
      origin: this.node_id,
      from: this.node_id,
      hop: 0,
      data: data.toString("base64"),
    };
    this.msg_cache.set(msg_id, msg);

    const targets = this.mesh.get(topic) || this.peers;
    const targetArr = Array.from(targets.size > 0 ? targets : this.peers);
    for (const peer of targetArr) {
      await this._send(peer, msg).catch((e) => console.error(`Failed to send to ${peer}`, e));
    }

    return msg_id;
  }

  async handle_raw(from_id: string, raw: Buffer): Promise<boolean> {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return false;
    }
    if (msg?.type !== "gossipsub") {
      return false;
    }

    const mt = msg.msg_type;
    if (mt === "MESSAGE") {
      await this._handle_message(from_id, msg);
    } else if (mt === "GRAFT") {
      this._handle_graft(from_id, msg);
    } else if (mt === "PRUNE") {
      this._handle_prune(from_id, msg);
    } else if (mt === "IHAVE") {
      this._handle_ihave(from_id, msg);
    } else if (mt === "IWANT") {
      this._handle_iwant(from_id, msg);
    }
    return true; // We consumed this envelope
  }

  tick() {
    const now = Date.now();
    if (now - this._last_heartbeat >= this.config.heartbeat_interval) {
      this._heartbeat();
      this._last_heartbeat = now;
    }
  }

  private async _send(peer: string, msg: any) {
    if (peer === this.node_id) return;
    await this.send_fn(peer, JSON.stringify(msg));
  }

  private shuffle<T>(array: T[]): T[] {
    const out = [...array];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  private async _handle_message(from_id: string, msg: any) {
    const msg_id = msg.msg_id || "";
    const topic = msg.topic || "";
    const hop = msg.hop || 0;

    this._total_received++;

    if (this.seen_msgs.has(msg_id)) {
      return;
    }

    this.seen_msgs.add(msg_id);
    this.msg_cache.set(msg_id, msg);
    this._received.add(msg_id);
    this._hop_counts.set(msg_id, hop);

    if (!this.subscriptions.has(topic)) {
      return;
    }

    if (this.on_message) {
      const dataBuf = Buffer.from(msg.data || "", "base64");
      await this.on_message(topic, dataBuf);
    }

    const fwd = { ...msg };
    fwd.hop = hop + 1;
    fwd.from = this.node_id;

    const origin = msg.origin || "";
    const meshSet = this.mesh.get(topic) || new Set();
    const candidates = Array.from(meshSet).filter(
      (p) => p !== from_id && p !== origin
    );
    const shuffled = this.shuffle(candidates);

    if (shuffled.length > 0) {
      await this._send(shuffled[0], fwd).catch(() => {});
    }
    if (shuffled.length > 1) {
      const ihavePeers = shuffled.slice(1);
      for (const p of ihavePeers) {
        await this._send(p, {
          type: "gossipsub",
          msg_type: "IHAVE",
          topic: topic,
          msg_ids: [msg_id],
        }).catch(() => {});
      }
    }
  }

  private _handle_graft(from_id: string, msg: any) {
    const topic = msg.topic || "";
    if (!this.subscriptions.has(topic)) return;
    if (!this.mesh.has(topic)) this.mesh.set(topic, new Set());
    
    const mesh = this.mesh.get(topic)!;
    if (mesh.size < this.config.D_high) {
      mesh.add(from_id);
    } else {
      this._send(from_id, {
        type: "gossipsub",
        msg_type: "PRUNE",
        topic: topic,
        peers: [],
      }).catch(() => {});
    }
  }

  private _handle_prune(from_id: string, msg: any) {
    const topic = msg.topic || "";
    const mesh = this.mesh.get(topic);
    if (mesh) {
      mesh.delete(from_id);
    }
  }

  private _handle_ihave(from_id: string, msg: any) {
    const topic = msg.topic || "";
    if (!this.subscriptions.has(topic)) return;

    const wanted = (msg.msg_ids || []).filter(
      (mid: string) => !this.seen_msgs.has(mid) && !this._pending_iwant.has(mid)
    );

    if (wanted.length > 0) {
      wanted.forEach((w: string) => this._pending_iwant.add(w));
      this._send(from_id, {
        type: "gossipsub",
        msg_type: "IWANT",
        msg_ids: wanted.slice(0, 64),
      }).catch(() => {});
    }
  }

  private _handle_iwant(from_id: string, msg: any) {
    const msg_ids = msg.msg_ids || [];
    for (const mid of msg_ids) {
      if (this.msg_cache.has(mid)) {
        const cached = { ...this.msg_cache.get(mid) };
        cached.from = this.node_id;
        this._send(from_id, cached).catch(() => {});
      }
    }
  }

  private _heartbeat() {
    for (const topic of this.subscriptions) {
      this._maintain_mesh(topic);
      this._emit_gossip(topic);
    }
  }

  private _maintain_mesh(topic: string) {
    if (!this.mesh.has(topic)) this.mesh.set(topic, new Set());
    const mesh = this.mesh.get(topic)!;
    
    const validMesh = Array.from(mesh).filter(p => this.peers.has(p));
    this.mesh.set(topic, new Set(validMesh));

    const currentMesh = this.mesh.get(topic)!;

    if (currentMesh.size < this.config.D_low) {
      const candidates = Array.from(this.peers).filter(p => !currentMesh.has(p));
      const shuffled = this.shuffle(candidates);
      const want = this.config.D - currentMesh.size;
      for (const peer of shuffled.slice(0, want)) {
        currentMesh.add(peer);
        this._send(peer, {
          type: "gossipsub",
          msg_type: "GRAFT",
          topic: topic,
        }).catch(() => {});
      }
    } else if (currentMesh.size > this.config.D_high) {
      const excess = Array.from(currentMesh);
      const shuffled = this.shuffle(excess);
      const pruneCount = currentMesh.size - this.config.D;
      for (const peer of shuffled.slice(0, pruneCount)) {
        currentMesh.delete(peer);
        this._send(peer, {
          type: "gossipsub",
          msg_type: "PRUNE",
          topic: topic,
          peers: [],
        }).catch(() => {});
      }
    }
  }

  private _emit_gossip(topic: string) {
    const maxLen = this.config.max_ihave_length;
    const seenArray = Array.from(this.seen_msgs);
    const recent = seenArray.slice(-maxLen);
    if (recent.length === 0) return;

    const mesh = this.mesh.get(topic) || new Set();
    const non_mesh = Array.from(this.peers).filter(p => !mesh.has(p));
    if (non_mesh.length === 0) return;

    const num = Math.min(this.config.D_gossip, non_mesh.length);
    const sampled = this.shuffle(non_mesh).slice(0, num);

    for (const peer of sampled) {
      this._send(peer, {
        type: "gossipsub",
        msg_type: "IHAVE",
        topic: topic,
        msg_ids: recent,
      }).catch(() => {});
    }
  }
}
