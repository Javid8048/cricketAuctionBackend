# 🏏 Cricket Auction Arena - Backend

The real-time auction engine and REST API powering the **Cricket Auction Arena** platform.

## 🚀 Features
- **Real-Time Bidding Engine**: Server-controlled 10s countdown timer with Socket.IO broadcasts.
- **Race-Condition Safeguards**: Mutex locks & atomic Prisma database transactions prevent simultaneous duplicate bids.
- **Rules & Validation**:
  - Purse sufficiency checks.
  - 25-player maximum squad size enforcement.
  - 8 overseas maximum quota enforcement.
  - Minimum bid increments per valuation bracket.
- **Pre-Seeded Data**: 8 fictional teams, 50 detailed cricketers with T20 career statistics, and default demo accounts.
- **Role-Based Access Control**: Admin, Team Manager, and Spectator roles with JWT authentication.

## 🛠️ Tech Stack
- Node.js + Express + TypeScript
- Socket.IO
- Prisma ORM (SQLite zero-config local, PostgreSQL production ready)
- Zod, bcryptjs, jsonwebtoken
- Vitest automated test suite

## 🏁 Quickstart
```bash
# 1. Install dependencies
npm install

# 2. Push database schema
npx prisma db push

# 3. Seed database
npx ts-node prisma/seed.ts

# 4. Build and start
npm run build
npm start
```
Server runs at `http://localhost:5000`.

## 🧪 Tests
```bash
# Run Vitest test suite
npx vitest run

# Run multi-client real-time simulation test
node e2e-simulation-test.js
```
