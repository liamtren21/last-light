FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm test && npm run build
FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src/game ./src/game
COPY --from=build /app/db ./db
COPY --from=build /app/scripts/memory-maintenance.ts ./scripts/memory-maintenance.ts
COPY package.json ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4329
USER node
EXPOSE 4329
CMD ["node","node_modules/tsx/dist/cli.mjs","server/index.ts"]
