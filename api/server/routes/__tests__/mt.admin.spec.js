/**
 * Multi-tenant admin API — unit tests only (no external stack).
 * Always runs in CI. No MT_IT_LIVE or API_URL required.
 */
const request = require('supertest');
const express = require('express');
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', '..', '..') });

const requireAdminHeader = require('~/server/middleware/requireAdminHeader');
const adminRateLimiter = require('~/server/middleware/adminRateLimiter');
const adminRouter = require('../admin');

const ADMIN_SECRET = process.env.ADMIN_AUTH_SECRET || 'admin-auth-secret-min-16-chars';

const adminHeaders = {
  'X-LibreChat-Role': 'ADMIN',
  'X-Admin-Auth': ADMIN_SECRET,
  'Content-Type': 'application/json',
};

const app = express();
app.use(express.json());
app.use('/api/admin', requireAdminHeader, adminRateLimiter, adminRouter);

describe('MT admin API (unit)', () => {
  beforeAll(() => {
    process.env.ADMIN_AUTH_SECRET = ADMIN_SECRET;
  });

  it('GET /api/admin/tenants without auth returns 403', async () => {
    const res = await request(app).get('/api/admin/tenants');
    expect(res.status).toBe(403);
  });

  it('GET /api/admin/tenants with wrong secret returns 403', async () => {
    const res = await request(app)
      .get('/api/admin/tenants')
      .set('X-LibreChat-Role', 'ADMIN')
      .set('X-Admin-Auth', 'wrong-secret');
    expect(res.status).toBe(403);
  });

  it('GET /api/admin/tenants without role returns 403', async () => {
    const res = await request(app)
      .get('/api/admin/tenants')
      .set('X-Admin-Auth', ADMIN_SECRET);
    expect(res.status).toBe(403);
  });
});
