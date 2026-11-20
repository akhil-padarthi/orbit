/**
 * SIS integration via the IMS Global / 1EdTech OneRoster 1.1 REST API — the roster standard
 * supported by PowerSchool, Infinite Campus, Skyward, Aeries, Clever and most other SIS platforms.
 *
 * Pulls users, classes and enrollments, then upserts them idempotently keyed on sourcedId.
 * A second run with unchanged data makes no changes.
 */
import { all, one, run, newId, nowIso, tx } from '../db/database.js';
import { ApiClient } from './client.js';
import { ensureSectionConversation } from '../modules/messages.js';

const BASE = '/ims/oneroster/v1p1';
const PAGE_SIZE = 100;
const ROLE_MAP = { administrator: 'admin', teacher: 'teacher', student: 'student', parent: 'parent', guardian: 'parent' };

/** Fetch every page of a OneRoster collection using limit/offset + X-Total-Count. */
async function fetchAll(client, resource, onPage) {
  const items = [];
  let offset = 0;
  for (;;) {
    const { body, headers } = await client.request('GET', `${BASE}/${resource}`, { query: { limit: PAGE_SIZE, offset } });
    const page = body?.[resource] ?? [];
    items.push(...page);
    const total = Number(headers.get('x-total-count') ?? items.length);
    onPage?.(items.length, total);
    offset += PAGE_SIZE;
    if (!page.length || items.length >= total) break;
  }
  return items;
}

export async function syncOneRoster(integration, { progress }) {
  const client = new ApiClient({ baseUrl: integration.base_url, clientId: integration.client_id, clientSecret: integration.client_secret });
  const tenantId = integration.tenant_id;

  progress('Fetching users from SIS…');
  const users = await fetchAll(client, 'users', (n, t) => progress(`Fetched ${n}/${t} users`));
  progress('Fetching classes from SIS…');
  const classes = await fetchAll(client, 'classes');
  progress('Fetching enrollments from SIS…');
  const enrollments = await fetchAll(client, 'enrollments');
  progress(`Applying ${users.length} users, ${classes.length} classes, ${enrollments.length} enrollments…`);

  const summary = {
    users: { created: 0, updated: 0, deactivated: 0, unchanged: 0, skipped: 0 },
    sections: { created: 0, updated: 0, unchanged: 0 },
    enrollments: { added: 0, removed: 0 },
    guardianships: { added: 0 },
  };
  const now = nowIso();
  const campus = one('SELECT id FROM campuses WHERE tenant_id = ? ORDER BY created_at LIMIT 1', tenantId);

  tx(() => {
    // ---- Users ---------------------------------------------------------------
    const idBySourced = new Map();
    for (const u of users) {
      const role = ROLE_MAP[u.role];
      if (!role || !u.email) {
        summary.users.skipped++;
        continue;
      }
      const name = `${u.givenName ?? ''} ${u.familyName ?? ''}`.trim() || u.username || u.email;
      const email = u.email.toLowerCase();
      const grade = u.grades?.[0] ?? null;
      let existing = one('SELECT * FROM users WHERE tenant_id = ? AND external_id = ?', tenantId, u.sourcedId);
      if (!existing) {
        // Link a pre-existing local account with the same email instead of duplicating it.
        existing = one('SELECT * FROM users WHERE tenant_id = ? AND email = ? AND external_id IS NULL', tenantId, email);
      }
      if (u.status === 'tobedeleted') {
        if (existing && existing.status !== 'inactive') {
          run(`UPDATE users SET status = 'inactive', updated_at = ? WHERE id = ?`, now, existing.id);
          run('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?', now, existing.id);
          summary.users.deactivated++;
        }
        if (existing) idBySourced.set(u.sourcedId, existing.id);
        continue;
      }
      if (existing) {
        idBySourced.set(u.sourcedId, existing.id);
        const changed = existing.name !== name || existing.email !== email || existing.role !== role || existing.grade_level !== grade || existing.external_id !== u.sourcedId;
        if (changed) {
          run('UPDATE users SET name = ?, email = ?, role = ?, grade_level = ?, external_id = ?, updated_at = ? WHERE id = ?', name, email, role, grade, u.sourcedId, now, existing.id);
          summary.users.updated++;
        } else summary.users.unchanged++;
      } else {
        const id = newId();
        // SIS-provisioned accounts start as "invited" with no password until an admin activates them.
        run(
          `INSERT INTO users (id, tenant_id, email, name, role, password_hash, status, grade_level, external_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, 'invited', ?, ?, ?, ?)`,
          id, tenantId, email, name, role, grade, u.sourcedId, now, now,
        );
        idBySourced.set(u.sourcedId, id);
        summary.users.created++;
      }
    }

    // ---- Guardianships (student.agents → parent) -----------------------------------
    for (const u of users) {
      if (ROLE_MAP[u.role] !== 'student' || u.status === 'tobedeleted') continue;
      const studentId = idBySourced.get(u.sourcedId);
      for (const agent of u.agents ?? []) {
        const parentId = idBySourced.get(agent.sourcedId);
        if (!studentId || !parentId) continue;
        const res = run('INSERT OR IGNORE INTO guardianships (tenant_id, parent_id, student_id) VALUES (?, ?, ?)', tenantId, parentId, studentId);
        summary.guardianships.added += res.changes;
      }
    }

    // ---- Classes → sections -------------------------------------------------------
    const teacherOf = new Map();
    for (const e of enrollments) {
      if (e.role === 'teacher' && e.status !== 'tobedeleted' && (e.primary === true || e.primary === 'true' || !teacherOf.has(e.class.sourcedId))) {
        teacherOf.set(e.class.sourcedId, idBySourced.get(e.user.sourcedId) ?? null);
      }
    }
    const sectionBySourced = new Map();
    for (const c of classes) {
      if (c.status === 'tobedeleted') continue;
      const teacherId = teacherOf.get(c.sourcedId) ?? null;
      const existing = one('SELECT * FROM sections WHERE tenant_id = ? AND external_id = ?', tenantId, c.sourcedId);
      if (existing) {
        sectionBySourced.set(c.sourcedId, existing.id);
        const changed = existing.name !== c.title || existing.course_code !== (c.classCode ?? null) || existing.room !== (c.location ?? null) || existing.teacher_id !== teacherId;
        if (changed) {
          run('UPDATE sections SET name = ?, course_code = ?, room = ?, teacher_id = ? WHERE id = ?', c.title, c.classCode ?? null, c.location ?? null, teacherId, existing.id);
          summary.sections.updated++;
        } else summary.sections.unchanged++;
      } else {
        const id = newId();
        run(
          `INSERT INTO sections (id, tenant_id, campus_id, teacher_id, name, course_code, room, kind, external_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'class', ?, ?)`,
          id, tenantId, campus.id, teacherId, c.title, c.classCode ?? null, c.location ?? null, c.sourcedId, now,
        );
        sectionBySourced.set(c.sourcedId, id);
        summary.sections.created++;
      }
    }

    // ---- Student enrollments (full sync for SIS-managed sections) ------------------
    const wanted = new Map(); // sectionId -> Set(studentId)
    for (const sectionId of sectionBySourced.values()) wanted.set(sectionId, new Set());
    for (const e of enrollments) {
      if (e.role !== 'student' || e.status === 'tobedeleted') continue;
      const sectionId = sectionBySourced.get(e.class.sourcedId);
      const studentId = idBySourced.get(e.user.sourcedId);
      if (sectionId && studentId) wanted.get(sectionId).add(studentId);
    }
    for (const [sectionId, students] of wanted) {
      const current = new Map(all('SELECT student_id, source FROM enrollments WHERE section_id = ?', sectionId).map((r) => [r.student_id, r.source]));
      for (const sid of students) {
        if (!current.has(sid)) {
          run(`INSERT INTO enrollments (tenant_id, section_id, student_id, source, created_at) VALUES (?, ?, ?, 'sis', ?)`, tenantId, sectionId, sid, now);
          summary.enrollments.added++;
        }
      }
      for (const [sid, source] of current) {
        // Only remove enrollments the SIS owns; manual/requested ones are left alone.
        if (source === 'sis' && !students.has(sid)) {
          run('DELETE FROM enrollments WHERE section_id = ? AND student_id = ?', sectionId, sid);
          summary.enrollments.removed++;
        }
      }
      ensureSectionConversation(tenantId, sectionId);
    }
  });

  return summary;
}
