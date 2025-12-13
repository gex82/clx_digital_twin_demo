# Supply Chain Autopilot (Demo)

Client-ready demo (synthetic but “live-feeling”) showing a Control Tower + Transportation + Distribution + Inventory + Scenario Simulator + Agentic Playbooks, with **explainable analytics** and **approve & execute** actions that update state **in-browser**.

## What’s inside

- **Executive Brief**: exec-facing Q&A cards with “why” + recommended action buttons
- **Control Tower**: ranked exceptions (value-at-risk + risk score), drill-in detail, approve & execute
- **Network**: US geo scatter of plants/DCs with a simple risk overlay (Leaflet)
- **Transportation**: carrier scorecard, fuel index drift, at-risk shipments, retender logic (expected total cost)
- **Distribution**: DC throughput utilization proxy + choke risk
- **Inventory**: days-of-cover by DC for a selected SKU + SKU-specific rebalancing (greedy heuristic)
- **Scenario Simulator**: toggles + live run (inventory burn, shipment arrivals, fuel drift)
- **Playbooks**: “exception → decision → execution” workflows + guardrails (cyber degraded mode blocks execution)
- **Data Explorer**: view & download synthetic dataset JSON + state snapshot JSON

## How to run locally

Just open `index.html` in a browser (Chrome recommended).

## Deploy to Cloudflare Pages (free)

This repo is **pure static** (no build step).

1. Push the folder contents to a GitHub repository.
2. In Cloudflare Pages → *Create a project* → connect the repo.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** (leave empty) or `echo "no build"`
   - **Build output directory:** `/`
4. Save and deploy.

### SPA routing

This app uses **hash routing** (`#/exec`, `#/control`, etc.), so refreshes won’t 404.  
A `_redirects` file is included as a safety net.

## Notes on the “live-feeling” behavior

When **Run live** is enabled (Scenario Simulator), the demo:
- consumes inventory daily based on forecast demand
- advances shipments and delivers when ETA hits 0
- drifts the fuel index
- recomputes exceptions and KPIs on every tick

## License

Demo-only. Replace with your preferred license if needed.
