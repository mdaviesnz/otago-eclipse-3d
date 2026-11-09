# Otago Eclipse 3D

A sightline simulator that answers one question for any point in Otago: will terrain hide the sun during the 22 July 2028 total solar eclipse?

## Places

**Catalogue**:
The precomputed set of candidate viewing places shipped with the site, each with its verdict already worked out.
_Avoid_: database, index, results

**Catalogue spot**:
One place in the catalogue: either a scanned grid point or a POI.
_Avoid_: viewpoint (that is one POI kind), location, result

**POI**:
A catalogue spot taken from a named OpenStreetMap feature, such as a lookout, peak, picnic area or rest area.
_Avoid_: landmark, attraction

**Preset**:
One of the town-centre "Fly to" places. It is precomputed in full, including its horizon profile, and is never filtered out, because a blocked town is a real answer.
_Avoid_: town spot, shortcut, favourite

## The eclipse

**Contact**:
One of the five instants of the eclipse at a place: first contact, second contact (totality begins), maximum, third contact (totality ends) and last contact.
_Avoid_: phase, event, start/end (ambiguous between first/last and second/third)

**Totality**:
The interval between second and third contact, when the moon covers the whole sun.

**Near edge**:
A place where totality lasts under a minute, because it sits close to the edge of the path of totality.

## Sightlines

**Horizon**:
The elevation angle of the terrain skyline on a given bearing, as seen from the observer's eye.
_Avoid_: skyline height, terrain angle

**Ridge**:
The terrain point that sets the horizon on a bearing.

**Horizon profile**:
The horizon across the band of bearings the eclipsed sun passes through, stored for presets.

**Skyline strip**:
The simulator's main control: the horizon drawn as a silhouette with the sun's path across it. Moving the sun along the path sets the time.
_Avoid_: timeline, scrubber, chart

**Clearance**:
The sun's apparent altitude minus the horizon on the sun's bearing, at one contact. Positive means the sun's centre is above the skyline.
_Avoid_: margin, headroom

**Grazing**:
A contact that is clear, but by less than the sun's apparent radius, so part of the disc touches the skyline.

**Sightline check**:
The live, in-browser probe of terrain around a chosen point, used where no precomputed answer exists or to refine one.
_Avoid_: scan, analysis, test

## Verdicts

**Verdict**:
The answer for a place: its level, its scope, and whether it is grazing or near edge.
_Avoid_: result, rating, score

**Scope**:
Which contacts a verdict judges. Two verdicts with different scopes answer different questions and may legitimately disagree.
- **Totality scope**: second contact, maximum and third contact. Used for every place inside the path of totality, whether the verdict is stored or checked live.
- **Eclipse scope**: first contact, maximum and last contact, skipping any with the sun below the astronomical horizon. Second and third contact also count here: if either is blocked, or the sun is below the horizon then, a clear verdict becomes partial. Used only outside the path of totality, where there is no totality to judge.

**Level**:
The headline of a verdict, one of four values:
- **Clear**: every contact in scope has clearance above zero.
- **Partial**: some contacts in scope are blocked, but not all.
- **Blocked**: every contact in scope is blocked. A contact is blocked when its clearance is zero or less.
- **Below**: the sun is below the astronomical horizon at every contact in scope.

Grazing and near edge never change the level.
_Avoid_: status, visible/invisible

**Whole totality**:
A totality-scoped verdict whose level is clear.
_Avoid_: full totality, clear totality
