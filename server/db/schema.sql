-- Orbit schema. Every tenant-owned row carries tenant_id and every query filters on it.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,          -- the "school code" users type at login
  name        TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'America/New_York',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campuses (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  address     TEXT,
  latitude    REAL NOT NULL,
  longitude   REAL NOT NULL,
  radius_m    REAL NOT NULL DEFAULT 150,     -- geofence radius
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campuses_tenant ON campuses(tenant_id);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','teacher','student','parent')),
  password_hash TEXT,                        -- NULL for SIS-provisioned accounts until activated
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','inactive')),
  grade_level   TEXT,
  external_id   TEXT,                        -- SIS sourcedId
  lms_user_id   TEXT,                        -- LMS (Canvas) user id
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_users_tenant_role ON users(tenant_id, role);

CREATE TABLE IF NOT EXISTS guardianships (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_guardianships_student ON guardianships(student_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   TEXT NOT NULL,                 -- rotation family; reuse of a rotated token revokes the family
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  replaced_by TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);

CREATE TABLE IF NOT EXISTS sections (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campus_id     TEXT NOT NULL REFERENCES campuses(id),
  teacher_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  course_code   TEXT,
  room          TEXT,
  kind          TEXT NOT NULL DEFAULT 'class' CHECK (kind IN ('class','flex')),
  capacity      INTEGER,
  external_id   TEXT,                        -- SIS class sourcedId
  lms_course_id TEXT,                        -- LMS course id
  lms_attendance_assignment_id TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (tenant_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_sections_tenant ON sections(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sections_teacher ON sections(teacher_id);

CREATE TABLE IF NOT EXISTS enrollments (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  section_id  TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  student_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','sis','request')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (section_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  section_id   TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  starts_at    TEXT NOT NULL,
  ends_at      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','finalized','cancelled')),
  finalized_at TEXT,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_time ON sessions(tenant_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_sessions_section ON sessions(section_id, starts_at);

CREATE TABLE IF NOT EXISTS attendance_records (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('present','late','absent','excused')),
  method        TEXT NOT NULL CHECK (method IN ('geo','manual','system','request')),
  checked_in_at TEXT,
  latitude      REAL,
  longitude     REAL,
  accuracy_m    REAL,
  distance_m    REAL,
  note          TEXT,
  recorded_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (session_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance_records(student_id);

CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('session_join','absence_excuse')),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','denied','cancelled','completed','failed')),
  requester_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_id    TEXT REFERENCES sections(id) ON DELETE CASCADE,
  approver_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason        TEXT NOT NULL,
  decision_note TEXT,
  data          TEXT NOT NULL DEFAULT '{}',
  job_id        TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_tenant_status ON requests(tenant_id, status);

CREATE TABLE IF NOT EXISTS request_events (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id  TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  event       TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_events_request ON request_events(request_id);

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('direct','section')),
  section_id      TEXT REFERENCES sections(id) ON DELETE CASCADE,
  title           TEXT,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  last_message_at TEXT
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  last_read_at    TEXT,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS announcements (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  section_id  TEXT REFERENCES sections(id) ON DELETE CASCADE,  -- NULL = whole school
  author_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_announcements_tenant ON announcements(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  read_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS integrations (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('sis','lms')),
  provider       TEXT NOT NULL CHECK (provider IN ('oneroster','canvas')),
  base_url       TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  client_secret  TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_status    TEXT,
  last_summary   TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (tenant_id, kind)
);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_at       TEXT NOT NULL,
  locked_at    TEXT,
  last_error   TEXT,
  result       TEXT,
  progress     TEXT,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_run ON jobs(status, run_at);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(tenant_id, created_at);
