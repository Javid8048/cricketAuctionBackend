import { PrismaClient } from '@prisma/client';

export function getSanitizedDatabaseUrl(): string | undefined {
  let url = process.env.DATABASE_URL;
  if (!url) return undefined;

  url = url.trim();

  // If this is a PostgreSQL connection (e.g. Neon)
  if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
    // Neon PgBouncer pooler (-pooler) often fails with Prisma due to transaction mode
    // Direct endpoint (without -pooler) connects directly to PostgreSQL compute
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

if (dbUrl) {
  const masked = dbUrl.replace(/:([^:@]+)@/, ':****@');
  console.log(`[Database Configuration] Connecting to: ${masked}`);
}

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
