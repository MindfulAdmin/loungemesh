FROM node:22-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production
ENV PORT=8089
ENV BASE_PATH=/users
EXPOSE 8089
USER root
CMD ["node", "server.js"]
