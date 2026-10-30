# Lusong

Lusong helps people in Philippine cities decide whether and how to travel when streets flood.

## Language

**Commute check**:
The answer to "should I leave now, and which way?" for one trip, drawn from flood advisories and from other people's reports along the way.
_Avoid_: flood check, route check

**Answer**:
What a commute check returns: Go, Go another way, Wait, or No one knows.
_Avoid_: verdict (that is a single photo's reading), recommendation

**No one knows**:
The answer when rain is expected or falling and no report covers the way. Silence is never read as a dry road.
_Avoid_: unknown, Go

**Verdict**:
Lusong's reading of one photo: a depth range, whether vehicles can pass, and how sure it is.
_Avoid_: answer, result

**Report**:
One person's photo or voice note about one place at one time. It counts for 3 hours, or until a newer report of the same spot replaces it.
_Avoid_: post, submission, sighting

**Photo report**:
A report whose depth Lusong reads from the photo itself.

**Voice report**:
A report with words but no photo. It can mark a way not passable, never passable.
_Avoid_: audio report

**Trip**:
A commuter's saved home and work points.
_Avoid_: route (a route is one way to make the trip)

**Route**:
One way along the roads to make a trip.
_Avoid_: path, way (in written text)

**Watcher**:
A standing request to check a trip during a time window and message the commuter on Telegram when the window opens and whenever the answer changes.
_Avoid_: alert, subscription

**Window**:
The hours, in Philippine time, when a watcher checks its trip: up to 4 hours within one day, such as 06:00 to 08:00.
_Avoid_: schedule (the scheduler is what calls the tick)

**Tick**:
One run of the watcher's scheduler, every 10 minutes: it checks each linked watcher that is inside its window.
_Avoid_: cron job, poll

**Light vehicle**:
A car or a motorbike, the vehicles that the "not passable to light vehicles" line stops.
_Avoid_: small vehicle

**Street flood**:
Standing water on a road, where depth decides whether a vehicle or a person can pass.
_Avoid_: flooding (unqualified)

**Flash flood**:
Water rising fast, where the rate of rise decides the danger. Lusong does not judge flash floods.
_Avoid_: flood surge

**Flood advisory**:
PAGASA's province-wide notice that rain may flood named rivers within the next hours.
_Avoid_: flood warning, rain alert
