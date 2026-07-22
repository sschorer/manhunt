import { useEffect, useState } from 'react';

/**
 * A wall-clock that re-renders on a fixed cadence. Returns the current epoch-ms
 * time and ticks it every `intervalMs`, so a component can derive live
 * countdowns (see `matchClock.ts`) without owning its own timer. One second is
 * the natural cadence for a `MM:SS` HUD.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
