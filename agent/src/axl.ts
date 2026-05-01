export type TopologyPeer = {
  uri: string;
  up: boolean;
  inbound: boolean;
  public_key: string;
};

export type TopologyTreeNode = {
  public_key: string;
  parent: string;
  sequence: number;
};

export type Topology = {
  our_ipv6: string;
  our_public_key: string;
  peers: TopologyPeer[];
  tree: TopologyTreeNode[];
};

export class AxlClient {
  constructor(public readonly base: string) {}

  async topology(): Promise<Topology> {
    const res = await fetch(`${this.base}/topology`);
    if (!res.ok) throw new Error(`AXL /topology ${res.status}`);
    return (await res.json()) as Topology;
  }

  async send(destPeerId: string, body: string): Promise<number> {
    const res = await fetch(`${this.base}/send`, {
      method: "POST",
      headers: { "X-Destination-Peer-Id": destPeerId },
      body,
    });
    if (!res.ok) {
      throw new Error(`AXL /send ${res.status}: ${await res.text()}`);
    }
    return Number(res.headers.get("x-sent-bytes") ?? 0);
  }

  async recv(): Promise<{ from: string; body: Buffer } | null> {
    const res = await fetch(`${this.base}/recv`);
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`AXL /recv ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { from: res.headers.get("x-from-peer-id") ?? "", body: buf };
  }

  async peerIds(): Promise<string[]> {
    const t = await this.topology();
    return t.tree
      .map((n) => n.public_key)
      .filter((k) => k !== t.our_public_key);
  }

  /** Forward an MCP JSON-RPC request to a remote peer via the AXL P2P mesh.
   *  The AXL node proxies POST /mcp/{peerPubKey}/{service} over the P2P transport. */
  async mcp(peerPubKey: string, service: string, body: object): Promise<unknown> {
    const res = await fetch(`${this.base}/mcp/${peerPubKey}/${service}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`AXL /mcp/${service} ${res.status}: ${await res.text()}`);
    return res.json();
  }
}
