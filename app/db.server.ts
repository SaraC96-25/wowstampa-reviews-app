import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createPrismaClient();
  }
}

const prisma = global.prismaGlobal ?? createPrismaClient();

export default prisma;

function createPrismaClient() {
  const url = normalizeDatabaseUrl(process.env.DATABASE_URL);

  return new PrismaClient(
    url
      ? {
          datasources: {
            db: { url },
          },
        }
      : undefined,
  );
}

function normalizeDatabaseUrl(databaseUrl?: string) {
  if (!databaseUrl) return databaseUrl;

  try {
    const url = new URL(databaseUrl);
    const isSupabasePooler = url.hostname.includes("pooler.supabase.com");

    if (isSupabasePooler) {
      url.searchParams.set("pgbouncer", "true");
      if (!url.searchParams.has("connection_limit")) {
        url.searchParams.set("connection_limit", "1");
      }
    }

    return url.toString();
  } catch {
    return databaseUrl;
  }
}
