/**
 * LMS integration with the Canvas LMS REST API (Instructure).
 *
 *  - Course/user linking: Canvas courses and users carry `sis_course_id` / `sis_user_id`,
 *    which match the SIS sourcedIds Orbit already stores — so linking is exact, not fuzzy.
 *  - Attendance passback: each linked course gets an "Attendance" assignment (percent grading)
 *    and each student's attendance rate is posted as their grade via the Submissions API.
 */
import { all, one, run } from '../db/database.js';
import { ApiClient, nextLink } from './client.js';
import { summarize } from '../modules/attendance.js';

const clientFor = (integration) =>
  new ApiClient({ baseUrl: integration.base_url, clientId: integration.client_id, clientSecret: integration.client_secret, tokenPath: '/login/oauth2/token' });

/** Follow Canvas's Link-header pagination. */
async function paginate(client, path, query) {
  const out = [];
  let { body, headers } = await client.request('GET', path, { query: { per_page: 100, ...query } });
  out.push(...body);
  let next = nextLink(headers.get('link'));
  while (next) {
    const u = new URL(next);
    // Keep repeated keys (e.g. enrollment_type[]=student&enrollment_type[]=teacher) intact.
    const q = {};
    for (const [k, v] of u.searchParams) q[k] = k in q ? [].concat(q[k], v) : v;
    ({ body, headers } = await client.request('GET', u.pathname.replace(/^.*?\/api\/v1/, '/api/v1'), { query: q }));
    out.push(...body);
    next = nextLink(headers.get('link'));
  }
  return out;
}

export async function syncCanvas(integration, { progress }) {
  const client = clientFor(integration);
  const tenantId = integration.tenant_id;
  const accountId = 'self';

  progress('Fetching Canvas courses…');
  const courses = await paginate(client, `/api/v1/accounts/${accountId}/courses`, {});
  const summary = { coursesLinked: 0, coursesUnmatched: 0, usersLinked: 0, usersUnmatched: 0 };

  for (const course of courses) {
    const section = course.sis_course_id && one('SELECT id, lms_course_id FROM sections WHERE tenant_id = ? AND external_id = ?', tenantId, course.sis_course_id);
    if (!section) {
      summary.coursesUnmatched++;
      continue;
    }
    if (section.lms_course_id !== String(course.id)) run('UPDATE sections SET lms_course_id = ? WHERE id = ?', String(course.id), section.id);
    summary.coursesLinked++;

    progress(`Linking people in ${course.name}…`);
    const people = await paginate(client, `/api/v1/courses/${course.id}/users`, { 'enrollment_type[]': ['student', 'teacher'] });
    for (const p of people) {
      const user = p.sis_user_id && one('SELECT id, lms_user_id FROM users WHERE tenant_id = ? AND external_id = ?', tenantId, p.sis_user_id);
      if (!user) {
        summary.usersUnmatched++;
        continue;
      }
      if (user.lms_user_id !== String(p.id)) {
        run('UPDATE users SET lms_user_id = ? WHERE id = ?', String(p.id), user.id);
        summary.usersLinked++;
      }
    }
  }
  return summary;
}

/** Post each student's attendance rate for a section to the course's Attendance assignment. */
export async function pushAttendanceToCanvas(integration, sectionId, { progress }) {
  const section = one('SELECT * FROM sections WHERE id = ? AND tenant_id = ?', sectionId, integration.tenant_id);
  if (!section?.lms_course_id) return { skipped: true, reason: 'Section is not linked to an LMS course. Run an LMS sync first.' };
  const client = clientFor(integration);

  let assignmentId = section.lms_attendance_assignment_id;
  if (!assignmentId) {
    progress('Creating Attendance assignment in Canvas…');
    const { body } = await client.request('POST', `/api/v1/courses/${section.lms_course_id}/assignments`, {
      json: { assignment: { name: 'Attendance', points_possible: 100, grading_type: 'percent', submission_types: ['none'], published: true, description: 'Synced automatically by Orbit.' } },
    });
    assignmentId = String(body.id);
    run('UPDATE sections SET lms_attendance_assignment_id = ? WHERE id = ?', assignmentId, section.id);
  }

  const students = all(
    `SELECT u.id, u.name, u.lms_user_id FROM enrollments e JOIN users u ON u.id = e.student_id WHERE e.section_id = ? AND u.status != 'inactive'`,
    section.id,
  );
  let pushed = 0;
  let skipped = 0;
  for (const s of students) {
    if (!s.lms_user_id) {
      skipped++;
      continue;
    }
    const rows = all(
      `SELECT ar.status, COUNT(*) AS n FROM attendance_records ar JOIN sessions se ON se.id = ar.session_id
       WHERE se.section_id = ? AND se.status = 'finalized' AND ar.student_id = ? GROUP BY ar.status`,
      section.id, s.id,
    );
    const { rate } = summarize(rows);
    if (rate == null) {
      skipped++;
      continue;
    }
    await client.request('PUT', `/api/v1/courses/${section.lms_course_id}/assignments/${assignmentId}/submissions/${s.lms_user_id}`, {
      json: { submission: { posted_grade: `${rate}%` }, comment: { text_comment: `Attendance rate synced by Orbit (${rate}%).` } },
    });
    pushed++;
  }
  progress(`Posted grades for ${pushed} students`);
  return { section: section.name, assignmentId, pushed, skipped };
}
