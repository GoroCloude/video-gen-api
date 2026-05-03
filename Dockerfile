FROM node:20-alpine

# ffmpeg/ffprobe for video composition; font packages for caption rendering.
# ttf-liberation  → Liberation Sans/Serif/Mono (Arial/Times/Courier-compatible)
# ttf-freefont    → FreeSans/FreeSerif/FreeMono (Impact/Georgia/Comic Sans fallbacks)
# ttf-linux-libertine → Linux Libertine O (Palatino) + Linux Biolinum O (Calibri/Segoe fallbacks)
# ttf-dejavu      → DejaVu Sans/Serif/Mono (Verdana/Consolas fallbacks)
RUN apk add --no-cache \
    ffmpeg \
    fontconfig \
    ttf-dejavu \
    ttf-liberation \
    ttf-freefont \
    ttf-linux-libertine

# Map Windows font names (VALID_FONTS) to the installed Linux equivalents so
# libass can resolve them through fontconfig at render time.
COPY fonts/windows-aliases.conf /etc/fonts/conf.d/99-windows-aliases.conf
RUN fc-cache -f

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
