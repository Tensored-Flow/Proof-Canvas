FROM node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS dependencies
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      g++=4:12.2.0-3 \
      make=4.3-4.1 \
      python3=3.11.2-1+b1 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

# Source-bearing one-shot image for local backup/restore jobs. This stage is
# explicit so Compose never has to run operational commands from the generic
# build target. The final/default stage remains the web runtime below.
FROM build AS maintenance
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /var/lib/proofcanvas && chown node:node /var/lib/proofcanvas
USER node
HEALTHCHECK NONE
CMD ["node", "-e", "process.exit(0)"]

FROM node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /var/lib/proofcanvas && chown node:node /var/lib/proofcanvas
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
# Railway runs logical backup commands inside the deployed web image. Keep the
# narrow TypeScript maintenance dependency graph available without copying the
# rest of the application source into the slim runtime.
COPY --from=build --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=node:node /app/scripts/proofcanvas/backup.ts /app/scripts/proofcanvas/restore.ts ./scripts/proofcanvas/
COPY --from=build --chown=node:node /app/lib/proofcanvas/assetContent.server.ts /app/lib/proofcanvas/backup.server.ts /app/lib/proofcanvas/database.server.ts /app/lib/proofcanvas/frame.ts /app/lib/proofcanvas/latex.ts /app/lib/proofcanvas/schema.ts ./lib/proofcanvas/
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["./node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
