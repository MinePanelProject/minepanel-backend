import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { eq, sql } from 'drizzle-orm';
import { CreateUserDto } from 'src/auth/dto/register.dto';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { setupState, users } from 'src/db/schema';

export interface SetupStatus {
  initialAdminCreated: boolean;
  nextStep: 'register_admin' | 'complete';
}

// serializes first-admin bootstrap across concurrent requests (§8.1)
const SETUP_LOCK_KEY = 7330;

const isNonEmptyString = (value: string | undefined): value is string =>
  typeof value === 'string' && value.length > 0;
@Injectable()
export class SetupService implements OnModuleInit {
  private readonly logger = new Logger(SetupService.name);
  private bootstrapToken: string | null = null;

  constructor(
    @Inject(DRIZZLE) private db: DrizzleDB,
    private configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.configuredSetupToken() !== null) return;

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);

      const [state] = await tx
        .select()
        .from(setupState)
        .where(eq(setupState.id, 'singleton'))
        .limit(1);

      if (state?.initialAdminCreated) return;

      // Generate and log only while the advisory lock protects this
      // incomplete-state re-read from a concurrent setup completion.
      this.getOrGenerateBootstrapToken();
    });
  }

  async getSetupState(): Promise<SetupStatus> {
    // Upsert singleton row
    await this.db
      .insert(setupState)
      .values({ id: 'singleton', initialAdminCreated: false })
      .onConflictDoNothing();

    const [state] = await this.db
      .select()
      .from(setupState)
      .where(eq(setupState.id, 'singleton'))
      .limit(1);

    return {
      initialAdminCreated: state.initialAdminCreated,
      nextStep: state.initialAdminCreated ? 'complete' : 'register_admin',
    };
  }

  async initAdminRegister(
    createUser: CreateUserDto,
    setupToken: string | undefined,
  ): Promise<boolean> {
    const expectedToken = await this.expectedSetupToken();

    // An absent expected token is also invalid: 409 is reserved for a known
    // token that passes this gate and then loses the locked state re-read.
    if (
      expectedToken === null ||
      !isNonEmptyString(setupToken) ||
      !this.setupTokenMatches(setupToken, expectedToken)
    ) {
      throw new UnauthorizedException({ error: 'SetupTokenInvalid' });
    }

    // bcrypt runs before the transaction so the advisory lock is never held
    // during hashing
    const passwordHash = await bcrypt.hash(createUser.password, 10);

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);

      await tx
        .insert(setupState)
        .values({ id: 'singleton', initialAdminCreated: false })
        .onConflictDoNothing();

      const [state] = await tx
        .select()
        .from(setupState)
        .where(eq(setupState.id, 'singleton'))
        .limit(1);

      if (state.initialAdminCreated) {
        throw new ConflictException({ error: 'SetupAlreadyComplete' });
      }

      await tx.insert(users).values({
        email: createUser.email,
        username: createUser.username,
        passwordHash,
        status: 'ACTIVE',
        role: 'ADMIN',
      });

      // any failure above or below rolls back both the user and the flag
      await tx
        .update(setupState)
        .set({ initialAdminCreated: true })
        .where(eq(setupState.id, 'singleton'));
    });

    return true;
  }

  private configuredSetupToken(): string | null {
    const configured = this.configService.get<string>('SETUP_TOKEN');
    // a configured secret is used verbatim: never trimmed, never logged
    return isNonEmptyString(configured) ? configured : null;
  }

  private async expectedSetupToken(): Promise<string | null> {
    const configured = this.configuredSetupToken();
    if (configured !== null) return configured;

    // Startup creates the process-local fallback while setup is incomplete.
    // If no token exists (including after a completed-setup restart), reject
    // without probing setup state or disclosing completion.
    return this.bootstrapToken;
  }

  private getOrGenerateBootstrapToken(): string {
    if (this.bootstrapToken === null) {
      this.bootstrapToken = randomBytes(24).toString('base64url');
      // intentional single emission: the operator retrieves the token from the
      // service log (e.g. `docker compose logs nestjs`) and passes it as the
      // X-Setup-Token header to POST /api/setup/init
      this.logger.warn(
        'SETUP_TOKEN is not configured; generated one-time setup token for this process: ' +
          `${this.bootstrapToken} — pass it as the 'X-Setup-Token' header to ` +
          'POST /api/setup/init to create the first admin. The token is only in the ' +
          'service logs (e.g. `docker compose logs nestjs`) and changes on restart.',
      );
    }
    return this.bootstrapToken;
  }

  private setupTokenMatches(supplied: string, expected: string): boolean {
    // digests are fixed-length so timingSafeEqual never leaks length either
    const suppliedDigest = createHash('sha256').update(supplied, 'utf8').digest();
    const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
    return timingSafeEqual(suppliedDigest, expectedDigest);
  }
}
