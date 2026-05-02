FROM node:20-bookworm

# Install required tools for AXL compilation and python3/curl for bash scripts
RUN apt-get update && apt-get install -y golang make git openssl jq python3 curl

WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Copy the entire workspace
COPY . .

# IMPORTANT: Remove the embedded submodule to avoid clone issues
RUN rm -rf axl/upstream && \
    rm -rf axl/bin/node

# Build AXL binary from official source
RUN cd axl && \
    git clone --depth 1 https://github.com/gensyn-ai/axl upstream && \
    cd upstream && make build && cd .. && \
    mkdir -p bin && cp upstream/node bin/node && \
    chmod +x bin/node

# Generate required AXL cryptographic keys for the 4 mesh nodes
RUN cd axl && \
    for n in nodeA nodeB nodeC nodeS; do \
      mkdir -p data/$n && \
      openssl genpkey -algorithm ed25519 -out data/$n/private.pem; \
    done

# Install monorepo dependencies
RUN pnpm install

# Build the Next.js Web UI
RUN cd web && pnpm build

# Railway injects $PORT dynamically, but expose 3000 as default
EXPOSE 3000

# Start script: Boot the 4 local AXL mesh nodes in the background, then start Next.js
CMD bash scripts/start-nodes.sh && cd web && pnpm start
