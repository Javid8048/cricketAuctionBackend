# 🏏 Cricket Auction Arena — Backend API & Real-Time Engine

The real-time auction engine, Socket.IO WebSocket server, and REST API powering the **Cricket Auction Arena** platform.

⚡ **Live Production URL**: `https://cricketauctionbackend-1.onrender.com`  
🩺 **Health Probe**: `https://cricketauctionbackend-1.onrender.com/health`

---

## 🛠️ Technology Stack

| Category | Technology | Purpose |
| :--- | :--- | :--- |
| **Runtime Environment** | [Node.js (v20+)](https://nodejs.org/) | Server execution runtime with modern async I/O |
| **Web Framework** | [Express.js 4](https://expressjs.com/) | RESTful API endpoints, CORS handling, and middleware pipeline |
| **Language** | [TypeScript 5](https://www.typescriptlang.org/) | Strongly-typed interfaces for auction domain models and controllers |
| **Real-Time Engine** | [Socket.IO 4](https://socket.io/) | Full-duplex WebSocket rooms, synchronized 10s countdown ticker, event broadcasts |
| **Database ORM** | [Prisma ORM 5](https://www.prisma.io/) | Type-safe query builder, schema migrations, and relational modeling |
| **Driver Adapter** | [@prisma/adapter-pg](https://www.npmjs.com/package/@prisma/adapter-pg) | Direct PostgreSQL driver adapter with connection pooling |
| **Cloud Database** | [Prisma Postgres](https://www.prisma.io/postgres) | High-performance serverless PostgreSQL with built-in connection pooler |
| **Connection Pooling** | [Node pg (`pg.Pool`)](https://node-postgres.com/) | Connection lifecycle management, automatic reconnects, and socket timeouts |
| **Authentication & Security** | [JWT (`jsonwebtoken`)](https://jwt.io/) + [bcryptjs](https://www.npmjs.com/package/bcryptjs) | Stateless token authorization, password hashing, and role-based guards |
| **High Availability & Durability** | Custom Persistence Engine | Debounced JSON snapshots, automatic empty-DB auto-restoration, in-memory live fallbacks |
| **Testing** | [Vitest](https://vitest.dev/) + Supertest | Unit testing for purse limits, bid increments, overseas quotas, and multi-client simulation |
| **Cloud Hosting** | [Render Cloud Platform](https://render.com/) | Containerized web service with automated GitHub Git deployment |

---

## 🚀 Architectural Highlights

1. **Race-Condition Free Bidding**:
   - Mutex locks and atomic database transactions prevent competing franchises from submitting overlapping bids simultaneously.
   - Valid bids automatically reset the server timer to 10 seconds.
2. **Auction Engine & Validation Rules**:
   - Enforces minimum bid increment brackets (e.g. ₹100, ₹200, ₹500, ₹1000).
   - Validates franchise purse sufficiency prior to bid acceptance.
   - Restricts maximum overseas player quota and squad size limits.
   - Prevents self-bidding when a team already holds the lead bid.
3. **Resilient High-Availability Persistence**:
   - Automatic debounced background snapshotting to `latest-backup.json`.
   - In-memory hot-cache fallback guarantees 0-second downtime even during external cloud maintenance.
4. **Role-Based Access Control (RBAC)**:
   - `ADMIN`: Full authority over lots, pausing, resuming, gavel strikes, settings, and player assignments.
   - `TEAM`: Secure franchise manager credentials with dedicated squad roster and bidding controls.
   - `SPECTATOR`: Public read-only stream access.

---

## 🏁 Quickstart & Local Setup

```bash
# 1. Clone the repository
git clone https://github.com/Javid8048/cricketAuctionBackend.git
cd cricketAuctionBackend

# 2. Install dependencies
npm install

# 3. Configure environment variables
# Copy .env.example to .env and configure DATABASE_URL:
# DATABASE_URL="postgresql://user:password@localhost:5432/cricket_auction_db?schema=public"

# 4. Push database schema
npx prisma db push

# 5. Build and launch server
npm run build
npm start
```

The server starts at `http://localhost:5000`.

---

## 🧪 Automated Testing

```bash
# Run Vitest test suite
npm run test

# Run multi-client parallel WebSocket bidding simulation
node e2e-simulation-test.js
```
