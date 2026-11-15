# SahilBot Server in a container (multi-arch: linux/arm64 and linux/amd64). docs/server.md → Docker.
#
#   docker buildx build --platform linux/arm64,linux/amd64 -t sahilbot-server .
#   docker run -d --name sahilbot --restart unless-stopped --network host \
#     -v sahilbot-data:/data sahilbot-server                      # Linux: listens on 127.0.0.1:8787 only
#   docker exec sahilbot sahilbot-server pair                     # a pairing code
#
# Without --network host (Docker Desktop, a VM): publish on loopback and let it use TLS (self-signed):
#   docker run -d -p 127.0.0.1:8787:8787 -e SAHILBOT_LISTEN=0.0.0.0 -v sahilbot-data:/data sahilbot-server
#
# Secrets at rest: pass a master key as a Docker secret or env (SAHILBOT_MASTER_KEY, 64 hex characters),
# or SAHILBOT_PASSPHRASE; otherwise a key file in the data volume is used.

FROM node:24-bookworm-slim AS build
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_audit=false npm_config_fund=false
COPY package.json package-lock.json ./
# No install scripts: nothing downloads extra binaries (Electron is only a build-time package here).
RUN npm ci --ignore-scripts
COPY . .
RUN npx electron-vite build && node scripts/build-server.mjs && npm prune --omit=dev --ignore-scripts \
 && rm -rf node_modules/onnxruntime-node/bin/napi-v3/darwin node_modules/onnxruntime-node/bin/napi-v3/win32

FROM node:24-bookworm-slim
ENV NODE_ENV=production SAHILBOT_DATA=/data SAHILBOT_PORT=8787 SAHILBOT_LISTEN=127.0.0.1
WORKDIR /app
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/out/server ./out/server
COPY --from=build /src/out/renderer ./out/renderer
COPY --from=build /src/packs ./packs
COPY --from=build /src/docs ./docs
COPY --from=build /src/resources ./resources
RUN printf '#!/bin/sh\nexec node /app/out/server/index.js "$@"\n' > /usr/local/bin/sahilbot-server \
 && chmod +x /usr/local/bin/sahilbot-server \
 && mkdir -p /data /home/node/SahilBot && chown -R node:node /data /home/node
USER node
VOLUME ["/data"]
EXPOSE 8787
# The probe only (never the server): accept the self-signed certificate when it listens beyond loopback.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD NODE_TLS_REJECT_UNAUTHORIZED=0 node -e "const s=process.env.SAHILBOT_LISTEN==='127.0.0.1'?'':'s';fetch('http'+s+'://127.0.0.1:'+process.env.SAHILBOT_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/out/server/index.js", "serve"]
