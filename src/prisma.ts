import dns from 'dns';
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {}

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

export function getSanitizedDatabaseUrl(): string | undefined {
  let url = process.env.DATABASE_URL;
  if (!url) return undefined;

  url = url.trim();

  // If this is a PostgreSQL connection (e.g. Neon)
  if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
    // Both direct and -pooler work; direct endpoint avoids prepared statements issues with PgBouncer
    if (url.includes('-pooler.')) {
      url = url.replace('-pooler.', '.');
    }

    const hasQuery = url.includes('?');
    const separator = hasQuery ? '&' : '?';

    // 1. Ensure sslmode=require for cloud PostgreSQL
    if (!url.includes('sslmode=')) {
      url += `${separator}sslmode=require`;
    }

    // 2. Ensure connect_timeout=30 to handle Neon scale-to-zero cold-starts
    if (!url.includes('connect_timeout=')) {
      url += `&connect_timeout=30`;
    }

    // 3. Ensure pool_timeout=30
    if (!url.includes('pool_timeout=')) {
      url += `&pool_timeout=30`;
    }
  }

  return url;
}

const dbUrl = getSanitizedDatabaseUrl();

function initializePrisma(): PrismaClient {
  if (dbUrl && (dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://'))) {
    const masked = dbUrl.replace(/:([^:@]+)@/, ':****@');
    console.log(`[Database Configuration] Connecting via Node pg adapter to: ${masked}`);

    const pool = new Pool({
      connectionString: dbUrl,
      connectionTimeoutMillis: 30000,
      ssl: {
        rejectUnauthorized: false,
      },
    });

    const adapter = new PrismaPg(pool);
    return new PrismaClient({ adapter });
  }

  return new PrismaClient(
    dbUrl
      ? {
          datasources: {
            db: {
              url: dbUrl,
            },
          },
        }
      : undefined
  );
}

export const prisma = initializePrisma();
