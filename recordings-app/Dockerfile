FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production
ENV PORT=8088
ENV BASE_PATH=/recordings
ENV DATA_DIR=/data
ENV PASSWORD_FILE=/run/secrets/recordings-password
EXPOSE 8088
USER node
CMD ["node", "server.js"]
