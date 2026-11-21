/* Shared swipe physics: the page tabs and the document window move the same way. */

/** Past the first/last page the content rubber-bands: the further you pull, the more it resists. */
export function rubberBand(dx: number, width: number): number {
  const c = 0.55;
  return Math.sign(dx) * (1 - 1 / ((Math.abs(dx) * c) / width + 1)) * width;
}

/** Settings > Accessibility "Reduce motion" (or the device setting) is on. */
export function motionReduced(): boolean {
  return document.documentElement.classList.contains("reduce-motion");
}

/**
 * Critically damped spring (duration 0.5 s, bounce 0) from `from` to `to`, starting at the finger's
 * release velocity (px/s). `apply` gets each position (returning false stops the spring there);
 * `done` runs once it has settled.
 * Returns a function that stops it.
 */
export function springTo(
  from: number,
  to: number,
  velocity: number,
  apply: (x: number) => void | false,
  done?: () => void,
): () => void {
  if (motionReduced()) {
    apply(to);
    done?.();
    return () => {};
  }
  const omega = (2 * Math.PI) / 0.5;
  const offset = from - to;
  const t0 = performance.now();
  let frame = 0;
  const step = (now: number) => {
    const t = (now - t0) / 1000;
    const x = (offset + (velocity + omega * offset) * t) * Math.exp(-omega * t);
    if (t > 0.05 && Math.abs(x) < 0.5) {
      apply(to);
      done?.();
      return;
    }
    if (apply(to + x) === false) return;
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

/** Velocity (px/s) over the last ~100 ms of a drag. */
export function releaseVelocity(samples: Array<{ v: number; t: number }>): number {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const v = first && last && last.t > first.t ? ((last.v - first.v) / (last.t - first.t)) * 1000 : 0;
  // A finger tops out well below this; larger values are two samples a hair apart
  return Math.max(-8000, Math.min(8000, v));
}
