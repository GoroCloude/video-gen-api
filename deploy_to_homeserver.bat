ssh goro@192.168.1.42 "cd ~/image2video && git fetch origin && git reset --hard origin/main && docker compose build && docker compose up -d && docker compose logs --tail=20"
