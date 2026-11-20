import { all, one, run, newId, nowIso } from '../db/database.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { notFound, badRequest } from '../lib/http.js';
import { validate, z } from '../lib/validate.js';
import { checkGeofence, isValidCoordinate } from '../lib/geo.js';
import { config } from '../config.js';

const serialize = (c) => ({
  id: c.id, name: c.name, address: c.address, latitude: c.latitude, longitude: c.longitude, radiusM: c.radius_m,
});

const campusSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(200).optional().nullable(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusM: z.number().min(25).max(5000),
});

export function registerCampusRoutes(router) {
  router.use('/api', (r) => {
    r.get('/campuses', (ctx) => ({ campuses: all('SELECT * FROM campuses WHERE tenant_id = ? ORDER BY name', ctx.user.tenantId).map(serialize) }));

    r.post('/campuses', requirePermission('campuses.manage'), (ctx) => {
      const input = validate(campusSchema, ctx.body);
      const id = newId();
      run(`INSERT INTO campuses (id, tenant_id, name, address, latitude, longitude, radius_m, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, ctx.user.tenantId, input.name, input.address ?? null, input.latitude, input.longitude, input.radiusM, nowIso());
      ctx.status = 201;
      return { campus: serialize(one('SELECT * FROM campuses WHERE id = ?', id)) };
    });

    r.patch('/campuses/:id', requirePermission('campuses.manage'), (ctx) => {
      const c = one('SELECT * FROM campuses WHERE id = ? AND tenant_id = ?', ctx.params.id, ctx.user.tenantId);
      if (!c) throw notFound('Campus');
      const input = validate(campusSchema.partial(), ctx.body);
      run('UPDATE campuses SET name = ?, address = ?, latitude = ?, longitude = ?, radius_m = ? WHERE id = ?',
        input.name ?? c.name, input.address !== undefined ? input.address : c.address, input.latitude ?? c.latitude,
        input.longitude ?? c.longitude, input.radiusM ?? c.radius_m, c.id);
      return { campus: serialize(one('SELECT * FROM campuses WHERE id = ?', c.id)) };
    });

    // Preview: how far is this position from each campus geofence? (Used by the check-in screen.)
    r.get('/geo/check', (ctx) => {
      const latitude = Number(ctx.query.latitude);
      const longitude = Number(ctx.query.longitude);
      const accuracy = Number(ctx.query.accuracy ?? 0);
      if (!isValidCoordinate(latitude, longitude)) throw badRequest('latitude and longitude are required');
      const campuses = all('SELECT * FROM campuses WHERE tenant_id = ?', ctx.user.tenantId).map((c) => ({
        ...serialize(c),
        ...checkGeofence({ latitude, longitude, accuracy }, c),
      }));
      return { campuses, accuracyOk: accuracy <= config.attendance.maxAccuracyM, maxAccuracyM: config.attendance.maxAccuracyM };
    });
  }, authenticate);
}
