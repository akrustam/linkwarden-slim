#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
yarn prisma:generate
yarn workspace @linkwarden/prisma deploy
yarn test --run
