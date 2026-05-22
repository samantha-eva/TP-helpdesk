#!/bin/sh
npx prisma@5.22.0 migrate deploy
npx tsx prisma/seed.ts
node server.js
