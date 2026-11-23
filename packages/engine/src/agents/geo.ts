// shortcut: coordinates only for the cities the generator uses; add a city here if the data grows.
const CITIES: Record<string, [lat: number, lon: number]> = {
  Mumbai: [19.076, 72.8777],
  Bengaluru: [12.9716, 77.5946],
  Delhi: [28.6139, 77.209],
  Pune: [18.5204, 73.8567],
  Hyderabad: [17.385, 78.4867],
  Chennai: [13.0827, 80.2707],
  Kolkata: [22.5726, 88.3639],
  Ahmedabad: [23.0225, 72.5714],
  Bangkok: [13.7563, 100.5018],
};

/** Great-circle distance in km, or null when either city is unknown. */
export function distanceKm(from: string, to: string): number | null {
  const a = CITIES[from];
  const b = CITIES[to];
  if (!a || !b) return null;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Speed needed to cover the distance in the time, or null when it can't be judged (unknown city, no movement). */
export function speedKmh(from: string, to: string, elapsedMs: number): number | null {
  const km = distanceKm(from, to);
  if (km === null || km === 0) return null;
  return elapsedMs <= 0 ? Infinity : km / (elapsedMs / 3_600_000);
}
