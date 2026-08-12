import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { DRIZZLE } from '../src/db/db.module';
import { DOCKERODE } from '../src/docker/docker.constants';
import { DockerService } from '../src/docker/docker.service';
import { assertSafeTestDatabase } from './test-database';

describe('AppController health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    assertSafeTestDatabase();
    const db = {
      execute: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue([]),
        })),
      })),
    };
    const docker = { ping: jest.fn().mockResolvedValue(true) };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .overrideProvider(DockerService)
      .useValue(docker)
      .overrideProvider(DOCKERODE)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication<App>();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports the explicit healthy database and docker providers', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', db: 'ok', docker: 'ok', version: process.env.PANEL_VERSION });
  });
});
