import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { GameImporterModule } from '../src/game-importer/game-importer.module';
import { ImportJobEntity } from '../src/game-importer/entities/import-job.entity';

describe('Management console (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.SOURCE_ALLOWED_HOSTS = 'www.crazygames.com';
    process.env.ALLOW_ANY_HTTPS = 'false';
    process.env.QUEUE_DRIVER = 'memory';
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          entities: [ImportJobEntity],
          synchronize: true,
        }),
        GameImporterModule,
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the console page as HTML', async () => {
    const res = await request(app.getHttpServer()).get('/console').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('id="sourceUrl"');
    expect(res.text).toContain('/game-imports');
  });

  it('redirects the root to the console', async () => {
    await request(app.getHttpServer())
      .get('/')
      .expect(302)
      .expect('Location', '/console');
  });

  it('lists jobs (empty at first, then with the created job)', async () => {
    await request(app.getHttpServer())
      .get('/game-imports')
      .expect(200)
      .expect((res) => {
        if (!Array.isArray(res.body)) throw new Error('expected an array');
      });
    const created = await request(app.getHttpServer())
      .post('/game-imports')
      .send({ sourceUrl: 'https://www.crazygames.com/game/x' })
      .expect(201);
    const listed = await request(app.getHttpServer())
      .get('/game-imports')
      .expect(200);
    expect(listed.body.map((j: { id: string }) => j.id)).toContain(
      created.body.id,
    );
  });
});
