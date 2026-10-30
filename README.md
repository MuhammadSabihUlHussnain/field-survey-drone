# Field Survey Drone

A browser prototype of Group D's CSC 424 project. A simulated drone flies a planned route over a corn field, scans every plant it passes, and flags the ones that look diseased. The farmer then reviews each flagged zone on a map and approves or rejects it for treatment.

> Decision support only. Not a plant diagnosis.

**Live demo:** https://muhammadsabihulhussnain.github.io/field-survey-drone/

## What you can do

1. **Plan.** Load a field (or build one from a seed), set how much of it is diseased and whether the disease is scattered or in patches. The app lays out a back-and-forth route. You can drag, add or delete waypoints, and it warns you which crop rows the camera would miss.
2. **Fly.** Press Start Survey. The drone takes off from the pad, visits each waypoint, and reads every plant inside its camera footprint. Each reading goes through the rule-based detector, and anything at 0.5 confidence or above gets a marker. You can pause, stop, or run at 1×, 2× or 4×. If the battery drops below 20% the drone abandons the route and flies home, and it keeps what it already scanned.
3. **Review.** When the drone lands, the map dashboard opens. Flagged plants within 3 m of each other are grouped into zones. Click a zone to see its readings, then approve or reject it. Decisions are saved with a timestamp. Export the survey as CSV, the results as JSON, or the full survey log.

You can also schedule a survey for later (the Survey Timer starts it on its own), reopen any earlier survey, and switch on a ground-truth check that shows how many diseased plants the detector caught. That check only exists because the field is simulated.

## Run it locally

The page loads its config with `fetch`, so it needs a web server; opening `index.html` straight from disk will not work.

```bash
# any static server works
npx http-server -c-1 -p 8080 .
# or
python -m http.server 8080
```

Then open http://localhost:8080.

## Tests

The simulation core (`js/core`) has no browser dependencies, so it runs under Node 18 or newer:

```bash
npm test
```

Each test is named after the SRS requirement it checks (FR-1.2 seeded fields, FR-3.4 low-battery return, FR-4.4 the 0.5 threshold, FR-5.1 zone grouping, FR-6.1 CSV columns, and so on). GitHub Actions runs them on every push.

## Put it on GitHub Pages

1. Create a repository (for example `field-survey-drone`) and push this folder to its `main` branch.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
4. After a minute the site is live at `https://<github-username>.github.io/field-survey-drone/`.

Nothing needs building. Three.js is vendored in `vendor/`, so the app does not depend on a CDN.

## How the code maps to our design

The browser build keeps the class names and boundaries from the Group D UML diagrams, so the Unity version can follow the same structure.

| UML class / component | File |
| --- | --- |
| Field, Plant, HealthState | `js/core/field.js` |
| SurveyRoute, Waypoint | `js/core/route.js` |
| Camera Sensor | `js/core/camera.js` |
| IDiseaseDetector, RuleBasedDetector | `js/core/detectors.js` |
| Drone Controller (state chart) | `js/core/drone.js` |
| Survey Manager | `js/core/survey.js` |
| HealthMap, Zone | `js/core/healthmap.js` |
| Results Store | `js/core/storage.js`, `js/core/report.js` |
| Map Dashboard, 3D view | `js/main.js`, `js/ui/mapview.js`, `js/ui/scene3d.js` |

The detector is only ever reached through `detect(reading)`. A trained image classifier can take its place without touching the survey, drone or map code; the FR-4.6 test swaps in a different detector to prove it.

## Configuration

Every detector threshold lives in [`config/settings.json`](config/settings.json); none are hard-coded (FR-4.3).

- `detection.flagThreshold`: confidence at which a plant is flagged (0.5).
- `detection.ruleBased.rules`: for each reading feature, the value that counts as healthy, the value that counts as diseased, and a weight. A feature scores 0 at its healthy value and 1 at its diseased value, and the confidence is the weighted average.
- `zones.groupingDistance`: how close flagged plants must be to share a zone (3 m).
- `drone.returnBelowPercent`: the low-battery rule (20%).
- `camera`: field of view and the sensor noise added to each reading.

Change a value, reload the page, and run the survey again.

## Field files

A field definition is a small JSON file. The two samples are in [`fields/`](fields/).

```json
{
  "fieldId": "south-field",
  "name": "South Field",
  "cropType": "corn",
  "grid": { "columns": 50, "rows": 50, "spacing": 1.0 },
  "seed": 424,
  "diseasedShare": 0.08,
  "distribution": "patches"
}
```

The same seed always builds the same field, and the same field and route always give the same detections.

## Requirements covered

| SRS requirement | Status |
| --- | --- |
| UI-1 main menu (New Survey, Load Field, Schedule Survey, Quit) | Done |
| UI-2 camera view beside a status panel (battery, waypoint *n of N*, plants scanned) | Done, refreshed 4× a second (FR-3.3) |
| UI-3 map markers: yellow pending, red approved, grey rejected | Done |
| UI-4 zone detail with readings, average and highest confidence, Approve / Reject | Done |
| UI-5 "Decision support only" line on results screens | Done |
| FR-1.1 to FR-1.4 field loading, seeded health states, visible symptoms, diseased share and pattern | Done |
| FR-2.1 to FR-2.3 lawnmower route, waypoint editing, unscanned-row warning | Done |
| FR-3.1 to FR-3.6 take-off and waypoint order, altitude hold, low-battery return, pause / resume / stop, scheduled start | Done |
| FR-4.1 to FR-4.6 plant readings, detector interface, config thresholds, 0.5 flag, full log, swappable detector | Done |
| FR-5.1 to FR-5.5 3 m zones, dashboard opens on landing, approve / reject, timestamped decisions, earlier surveys kept | Done |
| FR-6.1 CSV export with the required columns; FR-6.2 summary panel | Done |
| PR-1 2,500 plants; PR-2 detection under 5 ms; PR-3 map within 3 s of landing; PR-4 full survey under 5 minutes at 1×, with 2× and 4× | Done (default survey takes about 2 min 50 s) |

## Differences from the Unity plan

This is a browser build of the same design, made so the prototype can be shared as a link.

- It runs in JavaScript and three.js rather than Unity and C#.
- Results are kept in the browser's local storage and offered as downloads instead of being written to a folder. The browser keeps the full survey log for the most recent survey only.
- A scheduled survey only starts if the tab is still open.
- The Treated plant state from the state chart is not modelled yet.

## Known limitation

The plant readings are simulated, with controlled differences between healthy, stressed and diseased plants. That makes them easier to separate than a real field would be, so the detector's catch rate here says nothing about real crops. Validating on real imagery is future work.

## Team

Group D, CSC 424-H001, The University of Southern Mississippi, Fall 2026: Aditya Sharma, Intisar Waheed, Joseph Weaver, Muhammad Sabih Ul Hussnain and Saleep Shrestha.

## Third-party code

[three.js](https://threejs.org) r169 (MIT License), vendored in `vendor/` with its license file.
