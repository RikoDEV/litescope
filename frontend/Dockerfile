FROM node:26-alpine AS builder
RUN npm install -g pnpm@latest
WORKDIR /app
COPY package.json pnpm.yaml ./
RUN pnpm install --no-frozen-lockfile --dangerously-allow-all-builds
COPY . .
# Override the package.json version at release time (e.g. from a git tag).
ARG VERSION
ENV APP_VERSION=${VERSION}
RUN pnpm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
