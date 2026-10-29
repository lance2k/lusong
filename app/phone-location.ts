const LOCATION_TIMEOUT_MS = 15_000;

/** The phone's location for a report, asked for only when the reporter sends one. */
export function phoneLocation(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("This browser can't share its location."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error("Lusong needs your phone's location to place the report. Allow location and try again.")),
      { enableHighAccuracy: true, timeout: LOCATION_TIMEOUT_MS, maximumAge: 60_000 },
    );
  });
}
