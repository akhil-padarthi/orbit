/**
 * Mock SIS (OneRoster 1.1) and LMS (Canvas) servers so integrations can be demoed and tested
 * offline. They speak the same wire format as the real APIs — OAuth2 client-credentials tokens,
 * OneRoster limit/offset + X-Total-Count paging, Canvas Link-header paging — so the adapters
 * run unchanged against a real SIS or Canvas instance.
 *
 * Mounted at /mock/oneroster/:tenant and /mock/canvas/:tenant when DEMO_MODE is on.
 */
import crypto from 'node:crypto';
import { TENANTS } from '../../db/fixtures.js';
import { HttpError, sendJson } from '../../lib/http.js';

const tokens = new Map(); // token -> tenant slug
const canvasState = new Map(); // slug -> { assignments: Map, submissions: Map }
const MODIFIED = '2026-08-15T12:00:00.000Z';

const fixture = (slug) => {
  const t = TENANTS.find((x) => x.slug === slug);
  if (!t) throw new HttpError(404, 'not_found', 'Unknown tenant');
  return t;
};

function issueToken(ctx) {
  const t = fixture(ctx.params.tenant);
  const [scheme, encoded] = (ctx.req.headers.authorization ?? '').split(' ');
  const [id, secret] = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':') : [];
  if (ctx.body.grant_type !== 'client_credentials') throw new HttpError(400, 'unsupported_grant_type', 'Only client_credentials is supported');
  if (id !== `orbit-${t.slug}` || secret !== `${t.slug}-secret`) throw new HttpError(401, 'invalid_client', 'Invalid client credentials');
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, t.slug);
  return { access_token: token, token_type: 'bearer', expires_in: 3600 };
}

function requireToken(ctx) {
  const [scheme, token] = (ctx.req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || tokens.get(token) !== ctx.params.tenant) throw new HttpError(401, 'invalid_token', 'Invalid access token');
  return fixture(ctx.params.tenant);
}

// ---- OneRoster representation -------------------------------------------------
const ref = (slug, type, sourcedId) => ({ href: `/ims/oneroster/v1p1/${type}s/${sourcedId}`, sourcedId, type });

function orUsers(t) {
  const parentsOf = new Map();
  for (const u of t.sis.users) for (const a of u.agents ?? []) parentsOf.set(a, [...(parentsOf.get(a) ?? []), u.sourcedId]);
  return t.sis.users.map((u) => ({
    sourcedId: u.sourcedId,
    status: u.sisStatus ?? 'active',
    dateLastModified: MODIFIED,
    enabledUser: 'true',
    username: u.email,
    givenName: u.givenName,
    familyName: u.familyName,
    role: u.role,
    email: u.email,
    grades: u.grade ? [u.grade] : [],
    agents: [...(u.agents ?? []), ...(parentsOf.get(u.sourcedId) ?? [])].map((id) => ref(t.slug, 'user', id)),
    orgs: [ref(t.slug, 'org', `${t.slug}-org`)],
  }));
}

function orClasses(t) {
  return t.sis.classes.map((c) => ({
    sourcedId: c.sourcedId,
    status: 'active',
    dateLastModified: MODIFIED,
    title: c.title,
    classCode: c.classCode,
    classType: 'scheduled',
    location: c.location,
    periods: [String(c.period)],
    course: ref(t.slug, 'course', `${c.sourcedId}-course`),
    school: ref(t.slug, 'org', `${t.slug}-org`),
  }));
}

function orEnrollments(t) {
  const statusOf = (sid) => t.sis.users.find((u) => u.sourcedId === sid)?.sisStatus ?? 'active';
  const out = [];
  for (const c of t.sis.classes) {
    out.push({ sourcedId: `${c.sourcedId}-${c.teacher}`, status: 'active', dateLastModified: MODIFIED, role: 'teacher', primary: 'true',
      user: ref(t.slug, 'user', c.teacher), class: ref(t.slug, 'class', c.sourcedId), school: ref(t.slug, 'org', `${t.slug}-org`) });
    const students = [...c.students, ...t.sis.extraEnrollments.filter((e) => e.class === c.sourcedId).map((e) => e.student)];
    for (const s of students) {
      out.push({ sourcedId: `${c.sourcedId}-${s}`, status: statusOf(s), dateLastModified: MODIFIED, role: 'student', primary: 'false',
        user: ref(t.slug, 'user', s), class: ref(t.slug, 'class', c.sourcedId), school: ref(t.slug, 'org', `${t.slug}-org`) });
    }
  }
  return out;
}

function pageOneRoster(ctx, key, items) {
  const limit = Math.min(Number(ctx.query.limit ?? 100), 1000);
  const offset = Number(ctx.query.offset ?? 0);
  ctx.headers['X-Total-Count'] = String(items.length);
  return { [key]: items.slice(offset, offset + limit) };
}

// ---- Canvas representation ----------------------------------------------------
const canvasUserId = (t, sourcedId) => t.lms.userIdBase + t.sis.users.findIndex((u) => u.sourcedId === sourcedId) + 1;

function canvasCourses(t) {
  const courses = t.sis.classes.map((c) => ({
    id: t.lms.courses[c.sourcedId], name: c.title, course_code: c.classCode, sis_course_id: c.sourcedId, workflow_state: 'available',
  }));
  courses.push({ id: t.lms.userIdBase + 999, name: 'Teacher Sandbox', course_code: 'SANDBOX', sis_course_id: null, workflow_state: 'available' });
  return courses;
}

function state(slug) {
  if (!canvasState.has(slug)) canvasState.set(slug, { assignments: new Map(), submissions: new Map(), nextId: 70000 });
  return canvasState.get(slug);
}

/** Canvas-style pagination via Link header. The mock caps per_page at 3 so paging is always exercised. */
function pageCanvas(ctx, items) {
  const perPage = Math.min(Number(ctx.query.per_page ?? 10), 3);
  const page = Math.max(Number(ctx.query.page ?? 1), 1);
  const slice = items.slice((page - 1) * perPage, page * perPage);
  if (page * perPage < items.length) {
    const url = new URL(ctx.req.url, `http://${ctx.req.headers.host}`);
    url.searchParams.set('page', String(page + 1));
    url.searchParams.set('per_page', String(perPage));
    ctx.headers.Link = `<${url.toString()}>; rel="next"`;
  }
  return slice;
}

export function registerMockProviders(router) {
  // OneRoster
  router.post('/mock/oneroster/:tenant/oauth/token', issueToken);
  router.get('/mock/oneroster/:tenant/ims/oneroster/v1p1/users', (ctx) => pageOneRoster(ctx, 'users', orUsers(requireToken(ctx))));
  router.get('/mock/oneroster/:tenant/ims/oneroster/v1p1/classes', (ctx) => pageOneRoster(ctx, 'classes', orClasses(requireToken(ctx))));
  router.get('/mock/oneroster/:tenant/ims/oneroster/v1p1/enrollments', (ctx) => pageOneRoster(ctx, 'enrollments', orEnrollments(requireToken(ctx))));

  // Canvas
  router.post('/mock/canvas/:tenant/login/oauth2/token', issueToken);
  router.get('/mock/canvas/:tenant/api/v1/accounts/:account/courses', (ctx) => {
    const items = pageCanvas(ctx, canvasCourses(requireToken(ctx)));
    sendJson(ctx.res, 200, items, ctx.headers); // Canvas returns bare arrays
  });
  router.get('/mock/canvas/:tenant/api/v1/courses/:course/users', (ctx) => {
    const t = requireToken(ctx);
    const cls = t.sis.classes.find((c) => String(t.lms.courses[c.sourcedId]) === ctx.params.course);
    if (!cls) throw new HttpError(404, 'not_found', 'Course not found');
    const types = [].concat(ctx.query['enrollment_type[]'] ?? ['student', 'teacher']);
    const ids = [
      ...(types.includes('teacher') ? [cls.teacher] : []),
      ...(types.includes('student') ? [...cls.students, ...t.sis.extraEnrollments.filter((e) => e.class === cls.sourcedId).map((e) => e.student)] : []),
    ];
    const people = ids.map((sid) => {
      const u = t.sis.users.find((x) => x.sourcedId === sid);
      return { id: canvasUserId(t, sid), name: `${u.givenName} ${u.familyName}`, sortable_name: `${u.familyName}, ${u.givenName}`, sis_user_id: sid, login_id: u.email };
    });
    sendJson(ctx.res, 200, pageCanvas(ctx, people), ctx.headers);
  });
  router.post('/mock/canvas/:tenant/api/v1/courses/:course/assignments', (ctx) => {
    requireToken(ctx);
    const s = state(ctx.params.tenant);
    const a = { id: s.nextId++, course_id: Number(ctx.params.course), ...ctx.body.assignment };
    s.assignments.set(String(a.id), a);
    ctx.status = 201;
    return a;
  });
  router.put('/mock/canvas/:tenant/api/v1/courses/:course/assignments/:assignment/submissions/:user', (ctx) => {
    requireToken(ctx);
    const s = state(ctx.params.tenant);
    if (!s.assignments.has(ctx.params.assignment)) throw new HttpError(404, 'not_found', 'Assignment not found');
    const grade = ctx.body?.submission?.posted_grade;
    const sub = {
      id: s.nextId++, assignment_id: Number(ctx.params.assignment), user_id: Number(ctx.params.user), grade,
      score: grade ? Number(String(grade).replace('%', '')) : null, workflow_state: 'graded', graded_at: new Date().toISOString(),
    };
    s.submissions.set(`${ctx.params.assignment}:${ctx.params.user}`, sub);
    return sub;
  });
  router.get('/mock/canvas/:tenant/api/v1/courses/:course/assignments/:assignment/submissions', (ctx) => {
    requireToken(ctx);
    const s = state(ctx.params.tenant);
    const subs = [...s.submissions.values()].filter((x) => String(x.assignment_id) === ctx.params.assignment);
    sendJson(ctx.res, 200, subs);
  });
}
