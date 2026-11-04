# Depth-set run 2026-11-04T14-45-43-837Z

Commit submission-2026-11-05-28-g1198e78-dirty; 22 photos (tuning) × 2 draws; readers landmark, guided, hidden, sharing each draw's SAM replies; SAM from one cached pass per photo. Metered spend $2.0629; draws refused by the cap: 37.

Outcome compares the reading that decided the verdict with the caption's depth word, both as intervals from Lusong's landmark table; overlap is a match. Gap: cm between the two intervals (negative = too shallow, 0 on overlap), over measured draws. Rank: person-landmark steps from the caption's to the deciding one.

| Reader | Group | Draws | too shallow | matched | too deep | can't measure | no flood | error | mean gap cm | mean abs gap cm | mean rank |
|---|---|---|---|---|---|---|---|---|---|---|---|
| landmark | tuning flood | 30 | 8 | 10 | 3 | 8 | 0 | 1 | -9.6 | 13 | -1.4 |
| landmark | flood | 30 | 8 | 10 | 3 | 8 | 0 | 1 | -9.6 | 13 | -1.4 |
| landmark | tuning | 33 | 8 | 11 | 5 | 8 | 0 | 1 | -5.9 | 13.9 | -0.9 |
| landmark | wading | 3 | 0 | 1 | 2 | 0 | 0 | 0 | 20 | 20 | 2 |
| landmark | all | 33 | 8 | 11 | 5 | 8 | 0 | 1 | -5.9 | 13.9 | -0.9 |
| guided | tuning flood | 30 | 8 | 9 | 2 | 10 | 0 | 1 | -10.4 | 11.8 | -1.4 |
| guided | flood | 30 | 8 | 9 | 2 | 10 | 0 | 1 | -10.4 | 11.8 | -1.4 |
| guided | tuning | 32 | 8 | 10 | 3 | 10 | 0 | 1 | -8 | 12.1 | -1.1 |
| guided | wading | 2 | 0 | 1 | 1 | 0 | 0 | 0 | 15 | 15 | 1 |
| guided | all | 32 | 8 | 10 | 3 | 10 | 0 | 1 | -8 | 12.1 | -1.1 |
| hidden | tuning flood | 29 | 8 | 5 | 3 | 9 | 0 | 4 | -14.3 | 18.8 | -2.2 |
| hidden | flood | 29 | 8 | 5 | 3 | 9 | 0 | 4 | -14.3 | 18.8 | -2.2 |
| hidden | tuning | 30 | 9 | 5 | 3 | 9 | 0 | 4 | -14.1 | 18.4 | -2.1 |
| hidden | wading | 1 | 1 | 0 | 0 | 0 | 0 | 0 | -11 | 11 | -2 |
| hidden | all | 30 | 9 | 5 | 3 | 9 | 0 | 4 | -14.1 | 18.4 | -2.1 |

Paired transitions landmark → guided, held-out flood:

| change | draws |
|---|---|

Paired transitions landmark → guided, tuning flood:

| change | draws |
|---|---|
| cannot_measure → cannot_measure | 8 |
| too_shallow → too_shallow | 8 |
| matched → matched | 8 |
| too_deep → cannot_measure | 2 |
| matched → error | 1 |
| error → matched | 1 |
| too_deep → too_deep | 1 |
| matched → too_deep | 1 |

Paired transitions landmark → guided, all:

| change | draws |
|---|---|
| matched → matched | 9 |
| cannot_measure → cannot_measure | 8 |
| too_shallow → too_shallow | 8 |
| too_deep → cannot_measure | 2 |
| too_deep → too_deep | 2 |
| matched → error | 1 |
| error → matched | 1 |
| matched → too_deep | 1 |

Paired transitions landmark → hidden, held-out flood:

| change | draws |
|---|---|

Paired transitions landmark → hidden, tuning flood:

| change | draws |
|---|---|
| cannot_measure → cannot_measure | 8 |
| too_shallow → too_shallow | 8 |
| matched → matched | 5 |
| matched → error | 3 |
| too_deep → too_deep | 2 |
| error → error | 1 |
| too_deep → cannot_measure | 1 |
| matched → too_deep | 1 |

Paired transitions landmark → hidden, all:

| change | draws |
|---|---|
| cannot_measure → cannot_measure | 8 |
| too_shallow → too_shallow | 8 |
| matched → matched | 5 |
| matched → error | 3 |
| too_deep → too_deep | 2 |
| error → error | 1 |
| too_deep → cannot_measure | 1 |
| matched → too_deep | 1 |
| matched → too_shallow | 1 |

## Per photo, landmark

| Draws | n | too shallow | matched | too deep | can't measure | no flood | error |
|---|---|---|---|---|---|---|---|
| all | 33 | 8 | 11 | 5 | 8 | 0 | 1 |
| flood scenes | 30 | 8 | 10 | 3 | 8 | 0 | 1 |
| wading scenes | 3 | 0 | 1 | 2 | 0 | 0 | 0 |
| caption: thigh | 2 | 0 | 2 | 0 | 0 | 0 | 0 |
| caption: knee | 21 | 6 | 3 | 5 | 6 | 0 | 1 |
| caption: ankle | 4 | 0 | 2 | 0 | 2 | 0 | 0 |
| caption: waist | 6 | 2 | 4 | 0 | 0 | 0 | 0 |

| Photo | Draw | Caption | Lusong (deciding reading, class) | Outcome |
|---|---|---|---|---|
| 2016-southeastern-texas-floods-160421-z-zz999-002.jpg | 1 | thigh (50–72 cm) | 65–86 cm, NPATV | matched |
| 2016-southeastern-texas-floods-160421-z-zz999-002.jpg | 2 | thigh (50–72 cm) | 65–86 cm, NPATV | matched |
| au-morandarte-flickr-cavite-floods-2013-19-08-13-9547554519.jpg | 1 | knee (38–54 cm) | 66–140 cm, NPATV | too deep |
| au-morandarte-flickr-cavite-floods-2013-19-08-13-9547554519.jpg | 2 | knee (38–54 cm) | 66–140 cm, NPATV | too deep |
| au-morandarte-flickr-stranded-7-eleven-store-in-bacoor-due-t.jpg | 1 | knee (38–54 cm) | can't measure | can't measure |
| au-morandarte-flickr-stranded-7-eleven-store-in-bacoor-due-t.jpg | 2 | knee (38–54 cm) | can't measure | can't measure |
| banksstreetflooding12dec2009nola.jpg | 1 | knee (38–54 cm) | can't measure | can't measure |
| banksstreetflooding12dec2009nola.jpg | 2 | knee (38–54 cm) | can't measure | can't measure |
| defense-gov-news-photo-090421-f-0681l-130.jpg | 1 | knee (38–54 cm) | 18–27 cm, shallow | too shallow |
| defense-gov-news-photo-090421-f-0681l-130.jpg | 2 | knee (38–54 cm) | 5–10 cm, shallow | too shallow |
| flooded-street-14479903302.jpg | 1 | ankle (5–10 cm) | 5–10 cm, unsure | matched |
| flooded-street-14479903302.jpg | 2 | ankle (5–10 cm) | 5–10 cm, unsure | matched |
| man-standing-in-knee-deep-water-nino-f-scholten-photographic.jpg | 2 | knee (38–54 cm) | 38–54 cm, NPLV | matched |
| miami-tidal-flooding-with-rain-at-high-tide-during-king-tide.jpg | 1 | knee (38–54 cm) | 5–10 cm, unsure | too shallow |
| miami-tidal-flooding-with-rain-at-high-tide-during-king-tide.jpg | 2 | knee (38–54 cm) | 5–10 cm, unsure | too shallow |
| okinawa-28-may-1945-7118576313.jpg | 1 | knee (38–54 cm) | 5–10 cm, unsure | too shallow |
| okinawa-28-may-1945-7118576313.jpg | 2 | knee (38–54 cm) | 5–10 cm, unsure | too shallow |
| olga-stranded-motorist.jpg | 1 | knee (38–54 cm) | 30–45 cm, NPLV | matched |
| olga-stranded-motorist.jpg | 2 | knee (38–54 cm) | 66–140 cm, NPATV | too deep |
| sgt-barry-bergschneider-and-senior-airman-shane-rainwater-ar.jpg | 1 | knee (38–54 cm) | 84–112 cm, NPATV | too deep |
| sgt-barry-bergschneider-and-senior-airman-shane-rainwater-ar.jpg | 2 | knee (38–54 cm) | 84–112 cm, NPATV | too deep |
| statelibqld-1-111632-child-standing-ankle-deep-in-flooded-mo.jpg | 1 | ankle (5–10 cm) | can't measure | can't measure |
| statelibqld-1-111632-child-standing-ankle-deep-in-flooded-mo.jpg | 2 | ankle (5–10 cm) | can't measure | can't measure |
| statelibqld-1-252520-floodwaters-at-eagle-street-wharves-bri.jpg | 1 | waist (84–112 cm) | 100–133 cm, NPATV | matched |
| statelibqld-1-252520-floodwaters-at-eagle-street-wharves-bri.jpg | 2 | waist (84–112 cm) | 100–133 cm, NPATV | matched |
| statelibqld-1-388969-house-under-flood-at-tully-queensland-c.jpg | 1 | knee (38–54 cm) | can't measure | can't measure |
| statelibqld-1-388969-house-under-flood-at-tully-queensland-c.jpg | 2 | knee (38–54 cm) | can't measure | can't measure |
| statelibqld-1-91364-children-demonstrating-the-depth-of-floo.jpg | 1 | knee (38–54 cm) | 30–45 cm, NPLV | matched |
| statelibqld-1-91364-children-demonstrating-the-depth-of-floo.jpg | 2 | knee (38–54 cm) | error | error |
| texas-national-guard-rescue-operations-man-carrying-a-woman.jpg | 1 | waist (84–112 cm) | 65–86 cm, NPATV | matched |
| texas-national-guard-rescue-operations-man-carrying-a-woman.jpg | 2 | waist (84–112 cm) | 65–86 cm, NPATV | matched |
| west-street-january-20-1909-colfax-washington-15657627199.jpg | 1 | waist (84–112 cm) | 38–54 cm, NPLV | too shallow |
| west-street-january-20-1909-colfax-washington-15657627199.jpg | 2 | waist (84–112 cm) | 18–27 cm, unsure | too shallow |

## Per photo, guided

| Draws | n | too shallow | matched | too deep | can't measure | no flood | error |
|---|---|---|---|---|---|---|---|
| all | 32 | 8 | 10 | 3 | 10 | 0 | 1 |
| flood scenes | 30 | 8 | 9 | 2 | 10 | 0 | 1 |
| wading scenes | 2 | 0 | 1 | 1 | 0 | 0 | 0 |
| caption: thigh | 2 | 0 | 2 | 0 | 0 | 0 | 0 |
| caption: knee | 20 | 6 | 2 | 3 | 8 | 0 | 1 |
| caption: ankle | 4 | 0 | 2 | 0 | 2 | 0 | 0 |
| caption: waist | 6 | 2 | 4 | 0 | 0 | 0 | 0 |

| Photo | Draw | Caption | Lusong (deciding reading, class) | Outcome |
|---|---|---|---|---|
| 2016-southeastern-texas-floods-160421-z-zz999-002.jpg | 1 | thigh (50–72 cm) | 65–86 cm, NPATV | matched |
| 2016-southeastern-texas-floods-160421-z-zz999-002.jpg | 2 | thigh (50–72 cm) | 65–86 cm, NPATV | matched |
| au-morandarte-flickr-cavite-floods-2013-19-08-13-9547554519.jpg | 1 | knee (38–54 cm) | can't measure | can't measure |
| au-morandarte-flickr-cavite-floods-2013-19-08-13-9547554519.jpg | 2 | knee (38–54 cm) | can't measure | can't measure |
| au-morandarte-flickr-stranded-7-eleven-store-in-bacoor-due-t.jpg | 1 | knee (38–54 cm) | can't measure | can't measure |
| au-morandarte-flickr-stranded-7-eleven-store-in-bacoor-due-t.jpg | 2 | knee (38–54 cm) | can't measure | can't measure |
| banksstreetflooding12dec2009nola.jpg | 1 | knee (38–54 cm) | can't measure | can't measure |
| banksstreetflooding12dec2009nola.jpg | 2 | knee (38–54 cm) | can't measure | can't measure |
| defense-gov-news-photo-090421-f-0681l-130.jpg | 1 | knee (38–54 cm) | 18–27 cm, shallow | too shallow |
| defense-gov-news-photo-090421-f-0681l-130.jpg | 2 | knee (38–54 cm) | 5–10 cm, shallow | too shallow |
| flooded-street-14479903302.jpg | 1 | ankle (5–10 cm) | 5–10 cm, unsure | matched |
| flooded-street-14479903302.jpg | 2 | ankle (5–10 cm) | 5–10 cm, unsure | matched |
| man-standing-in-knee-deep-water-nino-f-scholten-photographic.jpg | 2 | knee (38–54 cm) | 30–45 cm, NPLV | matched |
| miami-tidal-flooding-with-rain-at-high-tide-during-king-tide.jpg | 1 | knee (38–54 cm) | 5–10 cm, unsure | too shallow |
| miami-tidal-flooding-with-rain-at-high-tide-during-king-tide.jpg | 2 | knee (38–54 cm) | 5–10 cm, unsure | too shallow |
| okinawa-28-may-1945-7118576313.jpg | 1 | knee (38–54 cm) | 5–10 cm, unsure | too shallow |
| okinawa-28-may-1945-7118576313.jpg | 2 | knee (38–54 cm) | 5–10 cm, unsure | too shallow |
| olga-stranded-motorist.jpg | 1 | knee (38–54 cm) | 66–140 cm, NPATV | too deep |
| olga-stranded-motorist.jpg | 2 | knee (38–54 cm) | 55–75 cm, NPATV | too deep |
| sgt-barry-bergschneider-and-senior-airman-shane-rainwater-ar.jpg | 2 | knee (38–54 cm) | 84–112 cm, NPATV | too deep |
| statelibqld-1-111632-child-standing-ankle-deep-in-flooded-mo.jpg | 1 | ankle (5–10 cm) | can't measure | can't measure |
| statelibqld-1-111632-child-standing-ankle-deep-in-flooded-mo.jpg | 2 | ankle (5–10 cm) | can't measure | can't measure |
| statelibqld-1-252520-floodwaters-at-eagle-street-wharves-bri.jpg | 1 | waist (84–112 cm) | 84–112 cm, NPATV | matched |
| statelibqld-1-252520-floodwaters-at-eagle-street-wharves-bri.jpg | 2 | waist (84–112 cm) | 84–112 cm, NPATV | matched |
| statelibqld-1-388969-house-under-flood-at-tully-queensland-c.jpg | 1 | knee (38–54 cm) | can't measure | can't measure |
| statelibqld-1-388969-house-under-flood-at-tully-queensland-c.jpg | 2 | knee (38–54 cm) | can't measure | can't measure |
| statelibqld-1-91364-children-demonstrating-the-depth-of-floo.jpg | 1 | knee (38–54 cm) | error | error |
| statelibqld-1-91364-children-demonstrating-the-depth-of-floo.jpg | 2 | knee (38–54 cm) | 38–54 cm, NPLV | matched |
| texas-national-guard-rescue-operations-man-carrying-a-woman.jpg | 1 | waist (84–112 cm) | 65–86 cm, NPATV | matched |
| texas-national-guard-rescue-operations-man-carrying-a-woman.jpg | 2 | waist (84–112 cm) | 65–86 cm, NPATV | matched |
| west-street-january-20-1909-colfax-washington-15657627199.jpg | 1 | waist (84–112 cm) | 38–54 cm, NPLV | too shallow |
| west-street-january-20-1909-colfax-washington-15657627199.jpg | 2 | waist (84–112 cm) | 38–54 cm, NPLV | too shallow |

## Per photo, hidden

| Draws | n | too shallow | matched | too deep | can't measure | no flood | error |
|---|---|---|---|---|---|---|---|
| all | 30 | 9 | 5 | 3 | 9 | 0 | 4 |
| flood scenes | 29 | 8 | 5 | 3 | 9 | 0 | 4 |
| wading scenes | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| caption: thigh | 1 | 0 | 1 | 0 | 0 | 0 | 0 |
| caption: knee | 19 | 7 | 0 | 3 | 7 | 0 | 2 |
| caption: ankle | 4 | 0 | 1 | 0 | 2 | 0 | 1 |
| caption: waist | 6 | 2 | 3 | 0 | 0 | 0 | 1 |

| Photo | Draw | Caption | Lusong (deciding reading, class) | Outcome |
|---|---|---|---|---|
| 2016-southeastern-texas-floods-160421-z-zz999-002.jpg | 2 | thigh (50–72 cm) | 65–86 cm, NPATV | matched |
| au-morandarte-flickr-cavite-floods-2013-19-08-13-9547554519.jpg | 1 | knee (38–54 cm) | 66–140 cm, NPATV | too deep |
| au-morandarte-flickr-cavite-floods-2013-19-08-13-9547554519.jpg | 2 | knee (38–54 cm) | can't measure | can't measure |
| au-morandarte-flickr-stranded-7-eleven-store-in-bacoor-due-t.jpg | 1 | knee (38–54 cm) | can't measure | can't measure |
| au-morandarte-flickr-stranded-7-eleven-store-in-bacoor-due-t.jpg | 2 | knee (38–54 cm) | can't measure | can't measure |
| banksstreetflooding12dec2009nola.jpg | 1 | knee (38–54 cm) | can't measure | can't measure |
| banksstreetflooding12dec2009nola.jpg | 2 | knee (38–54 cm) | can't measure | can't measure |
| defense-gov-news-photo-090421-f-0681l-130.jpg | 1 | knee (38–54 cm) | 5–10 cm, shallow | too shallow |
| defense-gov-news-photo-090421-f-0681l-130.jpg | 2 | knee (38–54 cm) | 5–10 cm, shallow | too shallow |
| flooded-street-14479903302.jpg | 1 | ankle (5–10 cm) | 5–10 cm, unsure | matched |
| flooded-street-14479903302.jpg | 2 | ankle (5–10 cm) | error | error |
| man-standing-in-knee-deep-water-nino-f-scholten-photographic.jpg | 2 | knee (38–54 cm) | 18–27 cm, unsure | too shallow |
| miami-tidal-flooding-with-rain-at-high-tide-during-king-tide.jpg | 1 | knee (38–54 cm) | 18–27 cm, unsure | too shallow |
| miami-tidal-flooding-with-rain-at-high-tide-during-king-tide.jpg | 2 | knee (38–54 cm) | 5–10 cm, unsure | too shallow |
| okinawa-28-may-1945-7118576313.jpg | 1 | knee (38–54 cm) | 5–10 cm, unsure | too shallow |
| okinawa-28-may-1945-7118576313.jpg | 2 | knee (38–54 cm) | 5–10 cm, unsure | too shallow |
| olga-stranded-motorist.jpg | 1 | knee (38–54 cm) | 66–140 cm, NPATV | too deep |
| olga-stranded-motorist.jpg | 2 | knee (38–54 cm) | 66–140 cm, NPATV | too deep |
| statelibqld-1-111632-child-standing-ankle-deep-in-flooded-mo.jpg | 1 | ankle (5–10 cm) | can't measure | can't measure |
| statelibqld-1-111632-child-standing-ankle-deep-in-flooded-mo.jpg | 2 | ankle (5–10 cm) | can't measure | can't measure |
| statelibqld-1-252520-floodwaters-at-eagle-street-wharves-bri.jpg | 1 | waist (84–112 cm) | 84–112 cm, NPATV | matched |
| statelibqld-1-252520-floodwaters-at-eagle-street-wharves-bri.jpg | 2 | waist (84–112 cm) | error | error |
| statelibqld-1-388969-house-under-flood-at-tully-queensland-c.jpg | 1 | knee (38–54 cm) | can't measure | can't measure |
| statelibqld-1-388969-house-under-flood-at-tully-queensland-c.jpg | 2 | knee (38–54 cm) | can't measure | can't measure |
| statelibqld-1-91364-children-demonstrating-the-depth-of-floo.jpg | 1 | knee (38–54 cm) | error | error |
| statelibqld-1-91364-children-demonstrating-the-depth-of-floo.jpg | 2 | knee (38–54 cm) | error | error |
| texas-national-guard-rescue-operations-man-carrying-a-woman.jpg | 1 | waist (84–112 cm) | 65–86 cm, NPATV | matched |
| texas-national-guard-rescue-operations-man-carrying-a-woman.jpg | 2 | waist (84–112 cm) | 65–86 cm, NPATV | matched |
| west-street-january-20-1909-colfax-washington-15657627199.jpg | 1 | waist (84–112 cm) | 18–27 cm, unsure | too shallow |
| west-street-january-20-1909-colfax-washington-15657627199.jpg | 2 | waist (84–112 cm) | 18–27 cm, unsure | too shallow |
