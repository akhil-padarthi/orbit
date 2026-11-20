import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp, useApi } from '../context.jsx';
import { Button, ErrorNote, Field, Loading } from '../ui.jsx';
import { Orbit, formatDistance } from '../Orbit.jsx';

export function Campus() {
  const { toast } = useApp();
  const { data, error, loading, reload } = useApi('/api/campuses');
  const campus = data?.campuses[0];
  const [form, setForm] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (campus) setForm({ name: campus.name, address: campus.address ?? '', latitude: campus.latitude, longitude: campus.longitude, radiusM: campus.radiusM });
  }, [campus?.id]);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setSaveError(null);
    try {
      await api(`/api/campuses/${campus.id}`, {
        method: 'PATCH',
        body: { ...form, latitude: Number(form.latitude), longitude: Number(form.longitude), radiusM: Number(form.radiusM) },
      });
      toast('Check-in zone saved', 'success');
      reload();
    } catch (err) {
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  }

  function useHere() {
    navigator.geolocation?.getCurrentPosition(
      (p) => setForm((f) => ({ ...f, latitude: +p.coords.latitude.toFixed(6), longitude: +p.coords.longitude.toFixed(6) })),
      () => setSaveError(new Error('Couldn’t read your location. Enter coordinates instead.')),
      { enableHighAccuracy: true },
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Campus check-in zone</h1>
          <p className="muted">Students can check in when their phone places them inside this circle. GPS drift of up to 30 m at the edge is forgiven.</p>
        </div>
      </header>
      <ErrorNote error={error} />
      {loading && !data ? <Loading /> : null}
      {form ? (
        <div className="grid-2">
          <form className="panel form-stack" onSubmit={save}>
            <Field label="Campus name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
            <Field label="Address"><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
            <div className="row-2">
              <Field label="Latitude"><input type="number" step="0.000001" value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} required /></Field>
              <Field label="Longitude"><input type="number" step="0.000001" value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} required /></Field>
            </div>
            <button type="button" className="text-btn" onClick={useHere}>Use my current location as the center</button>
            <Field label={`Radius: ${formatDistance(Number(form.radiusM))}`}>
              <input type="range" min="50" max="1000" step="10" value={form.radiusM} onChange={(e) => setForm({ ...form, radiusM: e.target.value })} />
            </Field>
            <ErrorNote error={saveError} />
            <Button variant="primary" type="submit" busy={busy}>Save zone</Button>
          </form>
          <section className="panel center">
            <Orbit radiusM={Number(form.radiusM)} label={`${form.name} zone, ${form.radiusM} metres`} />
            <p className="muted small">
              Center {Number(form.latitude).toFixed(5)}, {Number(form.longitude).toFixed(5)}
            </p>
          </section>
        </div>
      ) : null}
    </div>
  );
}
