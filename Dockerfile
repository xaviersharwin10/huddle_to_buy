FROM node:20-bookworm

# openssl: ed25519 key generation for AXL nodes
# python3 + curl + jq: used by start-nodes.sh and start-railway.sh
RUN apt-get update && apt-get install -y openssl python3 curl jq

WORKDIR /app

RUN npm install -g pnpm

COPY . .

# axl/bin/node is a committed x86-64 Linux ELF — no Go build needed.
# Just ensure it's executable and remove stale upstream source if present.
RUN rm -rf axl/upstream && chmod +x axl/bin/node

# Generate fresh ed25519 keys + node-config.json for all 4 mesh nodes.
# axl/data/ is gitignored so these must be created at image build time.
RUN cd axl && \
    mkdir -p data/nodeA data/nodeB data/nodeC data/nodeS && \
    openssl genpkey -algorithm ed25519 -out data/nodeA/private.pem && \
    openssl genpkey -algorithm ed25519 -out data/nodeB/private.pem && \
    openssl genpkey -algorithm ed25519 -out data/nodeC/private.pem && \
    openssl genpkey -algorithm ed25519 -out data/nodeS/private.pem && \
    echo '{"PrivateKeyPath":"private.pem","Peers":[],"Listen":["tls://127.0.0.1:9001"],"tcp_port":7000,"api_port":9002,"bridge_addr":"127.0.0.1"}' > data/nodeA/node-config.json && \
    echo '{"PrivateKeyPath":"private.pem","Peers":["tls://127.0.0.1:9001"],"Listen":["tls://127.0.0.1:9011"],"tcp_port":7001,"api_port":9012,"bridge_addr":"127.0.0.1"}' > data/nodeB/node-config.json && \
    echo '{"PrivateKeyPath":"private.pem","Peers":["tls://127.0.0.1:9001","tls://127.0.0.1:9011"],"Listen":[],"tcp_port":7002,"api_port":9022,"bridge_addr":"127.0.0.1"}' > data/nodeC/node-config.json && \
    echo '{"PrivateKeyPath":"private.pem","Peers":["tls://127.0.0.1:9001"],"Listen":[],"tcp_port":7003,"api_port":9032,"bridge_addr":"127.0.0.1"}' > data/nodeS/node-config.json

# Install monorepo dependencies (agent + bot; contracts not needed at runtime)
RUN pnpm install

# Railway exposes one port; default 8080 for the health-check server
EXPOSE 8080

CMD ["bash", "scripts/start-railway.sh"]
