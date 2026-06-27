import { DataSource, EntitySchema, MigrationInterface } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
}

// Canonical entity set. Every test DataSource registers ALL entities so that
// `synchronize` builds a consistent schema regardless of jest's (non-deterministic)
// file order. Registering a subset would let one suite create the `videos` table
// and a later subset-only suite deadlock against the `videos -> channels` FK when
// synchronize reconciles `channels`. The `entities` argument is kept for call-site
// readability but the canonical set is always used.
const CANONICAL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
];

export function createTestDataSource(
  _entities: (Function | string | EntitySchema<any>)[],
  options: TestDataSourceOptions = {},
): DataSource {
  const { synchronize = true, migrations } = options;
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: process.env.DB_DATABASE ?? 'streamtube',
    entities: CANONICAL_ENTITIES,
    synchronize,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  });
}

export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  await dataSource.query('DELETE FROM "videos"');
  await dataSource.query('DELETE FROM "refresh_tokens"');
  await dataSource.query('DELETE FROM "verification_tokens"');
  await dataSource.query('DELETE FROM "channels"');
  await dataSource.query('DELETE FROM "users"');
}
