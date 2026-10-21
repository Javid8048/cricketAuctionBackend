import { PrismaClient } from '@prisma/client';

export function getSanitizedDatabaseUrl(): string | undefined {
  let url = process.env.DATABASE_URL;
  if (!url) return undefined;

  url = url.trim();

  // If this is a PostgreSQL connection (e.g. Neon)
  if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
    const hasQuery = url.includes('?');
    const separator = hasQuery ? '&' : '?';

    // 1. Ensure sslmode=require for cloud PostgreSQL
    if (!url.includes('sslmode=')) {
      url += `${separator}sslmode=require`;
    }

    // 2. Ensure pgbouncer=true for Neon PgBouncer pooler
    if (url.includes('-pooler.') && !url.includes('pgbouncer=')) {
      url += `&pgbouncer=true`;
    }

    // 3. Ensure connect_timeout=30 to handle Neon scale-to-zero cold-starts
    if (!url.includes('connect_timeout=')) {
      url += `&connect_timeout=30`;
    }

    // 4. Ensure pool_timeout=30
    if (!url.includes('pool_timeout=')) {
      url += `&pool_timeout=30`;
    }
  }

  return url;
}

const dbUrl = getSanitizedDatabaseUrl();

export const prisma = new PrismaClient(
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
