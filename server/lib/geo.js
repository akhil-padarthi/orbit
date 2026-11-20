/** Geolocation helpers: great-circle distance and geofence checks. */

const EARTH_RADIUS_M = 6_371_008.8; // mean Earth radius (IUGG)
const toRad = (deg) => (deg * Math.PI) / 180;

/** Haversine distance between two coordinates, in meters. */
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isValidCoordinate(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

export const MAX_EDGE_TOLERANCE_M = 30;

/**
 * Decide whether a GPS fix is inside a circular geofence.
 * GPS jitter is forgiven at the fence edge by up to min(accuracy, 30 m);
 * fixes with poor accuracy overall are rejected separately by the caller.
 */
export function checkGeofence({ latitude, longitude, accuracy = 0 }, fence) {
  const distance = distanceMeters(latitude, longitude, fence.latitude, fence.longitude);
  const tolerance = Math.min(Math.max(accuracy, 0), MAX_EDGE_TOLERANCE_M);
  const inside = distance <= fence.radius_m + tolerance;
  return { inside, distance: Math.round(distance), radius: fence.radius_m };
}

/** Offset a coordinate by meters north/east — used by the demo location simulator and tests. */
export function offsetCoordinate(lat, lng, northM, eastM) {
  const dLat = northM / EARTH_RADIUS_M;
  const dLng = eastM / (EARTH_RADIUS_M * Math.cos(toRad(lat)));
  return { latitude: lat + (dLat * 180) / Math.PI, longitude: lng + (dLng * 180) / Math.PI };
}
