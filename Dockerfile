FROM node:20-slim

# Install OpenSSL and CA certificates for secure TLS to Neon PostgreSQL
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Define build environment variables (dummy URL ensures prisma generate compiles cleanly)
ENV PORT=5000 \
    DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" \
    JWT_SECRET="cricket-auction-arena-production-secret-2026"

# Copy package descriptors and prisma schema
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies so tsc is present)
RUN npm install --include=dev
RUN npx prisma generate

# Copy full application code and compile TypeScript
COPY . .
RUN npm run build

# Set runtime environment
ENV NODE_ENV=production

EXPOSE 5000

# Start server immediately
CMD ["node", "dist/server.js"]
