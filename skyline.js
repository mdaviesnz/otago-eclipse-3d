// The skyline strip and the verdict sentence: the real horizon, the sun's real path across it,
// and the words that answer the question. See GLOSSARY.md, "Skyline strip".
//
// Pure. No DOM, no Cesium, no astronomy: callers supply the horizon profile as [{ az, angle }],
// the sun's track as [{ t, az, alt }] in time order, and contacts as [{ t, x, ... }].

import { compassName, heightPhrase, handMeasure } from "./places.js";
import { nearEdgeNote } from "./catalogue.js";

// Horizon angle on a bearing, between stored samples. Off either end, the end value holds.
export function horizonAt(profile, az) {
  if (az <= profile[0].az) return profile[0].angle;
  for (let i = 1; i < profile.length; i++) {
    if (az <= profile[i].az) {
      const a = profile[i - 1], b = profile[i];
      return a.angle + ((az - a.az) / (b.az - a.az)) * (b.angle - a.angle);
    }
  }
  return profile[profile.length - 1].angle;
}

// Degrees of sky the chart needs to show everything, with room above the highest thing on it.
export function chartCeiling(profile, known, track) {
  const angles = [...(profile || []), ...(known || [])].map((p) => p.angle);
  const alts = (track || []).map((p) => p.alt);
  return Math.max(12, Math.ceil(Math.max(0, ...angles, ...alts) + 3));
}

export function skylineScales({ width, height, topPad, basePad, azLo, azHi, yMax }) {
  const base = height - basePad;
  return {
    base,
    X: (az) => ((az - azLo) / (azHi - azLo)) * width,
    Y: (alt) => base - (Math.max(0, alt) / yMax) * (base - topPad),
  };
}

export function skylinePath(profile, X, Y) {
  return profile.map((p, i) => `${i ? "L" : "M"}${X(p.az).toFixed(1)} ${Y(p.angle).toFixed(1)}`).join(" ");
}

// The track in runs, split where the sun passes behind the ridge. With no profile it is one run.
export function splitByVisibility(track, profile) {
  const runs = [];
  let run = null;
  for (const p of track) {
    const visible = !profile || p.alt > horizonAt(profile, p.az);
    if (!run || run.visible !== visible) {
      const start = run ? [run.points[run.points.length - 1]] : [];
      run = { visible, points: start };
      runs.push(run);
    }
    run.points.push(p);
  }
  return runs;
}

// The time on the track nearest a horizontal position. The sun moves steadily along its bearing,
// so x maps to time one to one; past either end, the end holds.
export function secondsAtX(track, X, x) {
  if (!track.length) return null;
  let best = track[0].t, bestD = Infinity;
  for (let i = 1; i < track.length; i++) {
    const x0 = X(track[i - 1].az), x1 = X(track[i].az);
    const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
    if (x >= lo && x <= hi && hi > lo) {
      return track[i - 1].t + ((x - x0) / (x1 - x0)) * (track[i].t - track[i - 1].t);
    }
    for (const [px, t] of [[x0, track[i - 1].t], [x1, track[i].t]]) {
      const d = Math.abs(px - x);
      if (d < bestD) { bestD = d; best = t; }
    }
  }
  return best;
}

// A contact close enough to the pointer to snap to, or null.
export function snapToContact(x, contacts, tolerancePx) {
  let best = null, bestD = tolerancePx;
  for (const c of contacts) {
    const d = Math.abs(c.x - x);
    if (d <= bestD) { best = c; bestD = d; }
  }
  return best;
}

// The next contact after `now` (direction 1) or the last one before it (direction -1).
export function adjacentContact(contacts, now, direction) {
  const sorted = [...contacts].sort((a, b) => a.t - b.t);
  if (direction > 0) return sorted.find((c) => c.t > now + 0.5) || null;
  return sorted.reverse().find((c) => c.t < now - 0.5) || null;
}

// What follows the place name in the verdict sentence.
export function verdictPredicate({ level, scope, grazing, hasPeak }) {
  if (scope === "totality") {
    if (level === "clear") return grazing ? " sees totality, only just." : " sees totality.";
    if (level === "partial") return " loses part of totality.";
    if (level === "blocked") return " loses totality.";
    return " has no view. The sun has set by then.";
  }
  if (!hasPeak) return " sees no eclipse.";
  if (level === "clear") return " sees a partial eclipse only.";
  if (level === "partial") return " sees only part of a partial eclipse.";
  if (level === "blocked") return " can’t see the eclipse.";
  return " has no view. The sun has set by then.";
}

// The sentence under it: why, and what to do on the day.
export function verdictReason({ level, scope, focus, peakPct, peakTime, totalitySeconds, nearEdge }) {
  const dir = compassName(focus.az);
  const look = `Look ${dir}, ${heightPhrase(focus.alt)}.`;
  const margin = handMeasure(Math.abs(focus.alt - focus.horizon));
  const edge = nearEdge ? ` ${nearEdgeNote(totalitySeconds)}` : "";

  if (focus.below) return `The sun is below the horizon at ${peakTime}.`;
  if (focus.blocked) {
    const who = focus.ridgeDist > 0
      ? `A ridge ${(focus.ridgeDist / 1000).toFixed(1)} km to the ${dir}`
      : `Terrain to the ${dir}`;
    return `${who} stands ${margin} above the sun at ${peakTime}.${edge}`;
  }
  if (scope !== "totality") {
    return `${peakPct} of the sun is covered at ${peakTime}. ${look} Keep eclipse glasses on the whole time.`;
  }
  if (level === "partial") return `The skyline cuts in during totality, so you would lose part of it. ${look}${edge}`;
  if (focus.grazing) return `${look} The sun’s lower edge touches the skyline, so stand a little higher if you can.${edge}`;
  return `${look} The sun clears the skyline by ${margin}.${edge}`;
}
