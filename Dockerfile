FROM node:20-alpine

# Install OpenSSL and libc compatibility required by Prisma on Alpine Linux
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Define build environment variables
ENV PORT=5000 \
    JWT_SECRET="cricket-auction-arena-production-secret-2026"

# Copy package descriptors and prisma schema
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies so tsc & ts-node are present)
RUN npm install --include=dev
RUN npx prisma generate

# Copy full application code and compile TypeScript
COPY . .
RUN npm run build

# Set runtime environment
ENV NODE_ENV=production

EXPOSE 5000

# At runtime, sync database tables, verify seed data, and start server
CMD ["sh", "-c", "npx prisma db push --skip-generate && npx ts-node prisma/seed.ts && node dist/server.js"]
