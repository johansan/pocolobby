FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# The build runs below, once the sources are here.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY site ./site
RUN mkdir -p /data && chmod 0700 /data
EXPOSE 8787
STOPSIGNAL SIGTERM
CMD ["node", "dist/cli.js", "server", "--db", "/data/pocolobby.db", "--host", "0.0.0.0", "--port", "8787", "--allow-remote"]
