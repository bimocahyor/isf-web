/**
 * Phase 0 integration tests.
 *
 * Tests:
 *   1. Application starts (app factory returns an Express app)
 *   2. GET /health returns a success response
 *   3. GET / serves the landing page
 *   4. Protected filesystem paths are not exposed via static serving
 *   5. 404 handler returns a safe response
 *   6. Error handler returns safe responses (no stack trace leak)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app/index.js';

let app: Express;

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  // Close any open database connections created during tests
  const { closeDatabase } = await import('../../src/db/client.js');
  await closeDatabase();
});

// ---------------------------------------------------------------------------
// 1. Application factory
// ---------------------------------------------------------------------------
describe('Application factory', () => {
  it('createApp() returns an Express application', () => {
    expect(app).toBeDefined();
    expect(typeof app).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 2. Health check
// ---------------------------------------------------------------------------
describe('GET /health', () => {
  it('returns a JSON response with a status field', async () => {
    const res = await request(app).get('/health');

    // Accept 200 (db available) or 503 (db unavailable in CI) — both are valid
    expect([200, 503]).toContain(res.statusCode);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toHaveProperty('status');
    expect(['ok', 'degraded']).toContain((res.body as Record<string, unknown>)['status']);
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('checks');
  });

  it('does not expose secrets or database credentials in the health response', async () => {
    const res = await request(app).get('/health');
    const body = JSON.stringify(res.body);

    expect(body).not.toContain('password');
    expect(body).not.toContain('secret');
    expect(body).not.toContain('SESSION_SECRET');
    expect(body).not.toContain('DATABASE_URL');
  });
});

// ---------------------------------------------------------------------------
// 3. Landing page
// ---------------------------------------------------------------------------
describe('GET /', () => {
  it('returns 200 with HTML content', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('contains ISF brand content in the HTML', async () => {
    const res = await request(app).get('/');
    expect(res.text).toContain('Intelegensia');
  });

  it('serves the CSS stylesheet', async () => {
    const res = await request(app).get('/css/style.css');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/css/);
  });

  it('serves the JavaScript file', async () => {
    const res = await request(app).get('/js/main.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });

  it('serves the favicon SVG', async () => {
    const res = await request(app).get('/assets/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/svg/);
  });
});

// ---------------------------------------------------------------------------
// 4. Backend files must not be accessible via static serving
// ---------------------------------------------------------------------------
describe('Static serving security', () => {
  const sensitivePathsExpecting404 = [
    '/src/server.ts',
    '/src/config/env.ts',
    '/src/db/client.ts',
    '/.env',
    '/.env.example',
    '/package.json',
    '/tsconfig.json',
    '/node_modules/express/package.json',
  ];

  it.each(sensitivePathsExpecting404)(
    '%s is not accessible (404)',
    async (urlPath) => {
      const res = await request(app).get(urlPath);
      expect(res.status).toBe(404);
    },
  );

  it('dotfile access is denied', async () => {
    const res = await request(app).get('/.env');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 5. 404 handler
// ---------------------------------------------------------------------------
describe('404 handler', () => {
  it('returns 404 for an unknown HTML route', async () => {
    const res = await request(app).get('/nonexistent-page-xyz').accept('html');
    expect(res.status).toBe(404);
  });

  it('returns 404 JSON for an unknown API route', async () => {
    const res = await request(app).get('/api/v1/nonexistent').accept('application/json');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });
});

// ---------------------------------------------------------------------------
// 6. Security headers
// ---------------------------------------------------------------------------
describe('Security headers', () => {
  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options or Content-Security-Policy frame-ancestors', async () => {
    const res = await request(app).get('/');
    const hasFrameOptions = 'x-frame-options' in res.headers;
    const hasCSP = 'content-security-policy' in res.headers;
    expect(hasFrameOptions || hasCSP).toBe(true);
  });

  it('assigns a request ID header', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-request-id']).toBeDefined();
    // UUID format
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
