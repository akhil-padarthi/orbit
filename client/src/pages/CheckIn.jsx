import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp, useFormat } from '../context.jsx';
import { Button, ErrorNote, Status } from '../ui.jsx';
import { Orbit, formatDistance } from '../Orbit.jsx';

const EARTH_R = 6371008.8;
function offset(lat, lng, northM, eastM) {
  const dLat = northM / EARTH_R;
  const dLng = eastM / (EARTH_R * Math.cos((lat * Math.PI) / 180));
  return { latitude: lat + (dLat * 180) / Math.PI, longitude: lng + (dLng * 180) / Math.PI };
}

// Demo-only presets so the geofence can be tried from anywhere.
const PRESETS = [
  { id: 'inside', label: 'In the building (40 m from center)', north: 25, east: 31, accuracy: 12 },
  { id: 'edge', label: 'At the edge of campus (fence + 20 m)', edge: 20, accuracy: 25 },
  { id: 'outside', label: 'At home (1.2 km away)', north: 900, east: 800, accuracy: 15 },
  { id: 'weak', label: 'Weak GPS signal (±180 m)', north: 20, east: 10, accuracy: 180 },
];

/** Student self check-in with geolocation, shown on the dashboard and the session page. */
export function CheckInPanel({ session, onCheckedIn }) {
  const { toast } = useApp();
  const fmt = useFormat();
  const [campus, setCampus] = useState(null);
  const [demoMode, setDemoMode] = useState(false);
  const [position, setPosition] = useState(null);
  const [preview, setPreview] = useState(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [record, setRecord] = useState(session.myStatus ? { status: session.myStatus } : null);

  useEffect(() => {
    api('/api/campuses').then((d) => setCampus(d.campuses[0])).catch(setError);
    api('/api/config').then((c) => setDemoMode(Boolean(c.demoMode))).catch(() => {});
  }, []);

  useEffect(() => {
    if (!position) return;
    api('/api/geo/check', { query: position })
      .then((d) => setPreview(d.campuses.find((c) => c.id === campus?.id) ?? d.campuses[0]))
      .catch(setError);
  }, [position?.latitude, position?.longitude, position?.accuracy]);

  function useDeviceLocation() {
    setError(null);
    if (!('geolocation' in navigator)) return setError(new Error('This browser can’t share location. Try the Orbit app on your phone.'));
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setPosition({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) });
      },
      (err) => {
        setLocating(false);
        setError(new Error(err.code === 1 ? 'Location permission is off. Allow location for this site in your browser settings, then try again.' : 'Couldn’t get your location. Check that location services are on and try again.'));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  function simulate(id) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p || !campus) return;
    setError(null);
    const coords = p.edge != null ? offset(campus.latitude, campus.longitude, campus.radiusM + p.edge, 0) : offset(campus.latitude, campus.longitude, p.north, p.east);
    setPosition({ ...coords, accuracy: p.accuracy });
  }

  async function checkIn() {
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/attendance/check-in', { method: 'POST', body: { sessionId: session.id, ...position } });
      setRecord(res.record);
      toast(res.alreadyCheckedIn ? 'You were already checked in.' : `Checked in to ${session.sectionName}`, 'success');
      onCheckedIn?.(res.record);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const done = record && ['present', 'late', 'excused'].includes(record.status);

  return (
    <section className="checkin" aria-labelledby="checkin-title">
      <div className="checkin-copy">
        <h2 id="checkin-title">{done ? 'You’re checked in' : `Check in to ${session.sectionName}`}</h2>
        <p className="muted">
          {session.room} · {fmt.time(session.startsAt)}–{fmt.time(session.endsAt)}
        </p>
        {done ? (
          <p className="checkin-done">
            <Status status={record.status} />
            {record.checkedInAt ? <span>at {fmt.time(record.checkedInAt)}</span> : null}
            {record.distanceM != null ? <span className="muted">{formatDistance(record.distanceM)} from campus center</span> : null}
          </p>
        ) : (
          <>
            <p>Share your location so Orbit can confirm you’re on campus. It’s only checked at the moment you tap check in.</p>
            <div className="checkin-actions">
              <Button onClick={useDeviceLocation} busy={locating}>Use my location</Button>
              {demoMode ? (
                <label className="sim">
                  <span className="sr-only">Simulate a location</span>
                  <select defaultValue="" onChange={(e) => simulate(e.target.value)} aria-label="Simulate a location (demo)">
                    <option value="" disabled>Demo: simulate a location…</option>
                    {PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            {preview ? (
              <p className={`preview ${preview.inside ? 'ok' : 'no'}`} data-testid="geo-preview">
                {preview.inside
                  ? `You’re inside the ${formatDistance(preview.radius)} check-in zone (${formatDistance(preview.distance)} from center).`
                  : `You’re ${formatDistance(preview.distance)} from campus — the zone is ${formatDistance(preview.radius)}.`}
                {position.accuracy ? ` GPS accuracy ±${position.accuracy} m.` : ''}
              </p>
            ) : null}
            <ErrorNote error={error} />
            <Button variant="primary" onClick={checkIn} busy={busy} disabled={!position} className="checkin-btn">
              Check in
            </Button>
          </>
        )}
      </div>
      {campus ? (
        <Orbit
          radiusM={campus.radiusM}
          you={preview && !done ? { distance: preview.distance, inside: preview.inside, accuracy: position?.accuracy } : done && record.distanceM != null ? { distance: record.distanceM, inside: true } : null}
          label={`${campus.name} check-in zone`}
        />
      ) : null}
    </section>
  );
}
