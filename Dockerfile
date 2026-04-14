FROM node:20-alpine

# ffmpeg and ffprobe are required for video composition and audio probing
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
