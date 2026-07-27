FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY cloud-bot/package.json cloud-bot/package-lock.json ./
RUN npm ci
COPY cloud-bot/tsconfig.json ./
COPY cloud-bot/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prompts/system.md prompts/identity.md prompts/soul.md prompts/tone-rules.md ./prompts/
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
