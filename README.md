# Auro Stage 2 Prototype

Yarn dyeing vessel planner for Vardhman Auro.

**Flow:** New Line → Auto-Plan Vessels → clubbing / vessels / capacity → Summary 1.

## Open

```bash
cd Prototype && python3 -m http.server 8765
# http://localhost:8765
```

Or open `index.html`.

## Use

1. **Load Example2 Demo** (or New Line) to get dyeing lines.
2. Edit norms/cones on the line table; edit Masters as needed.
3. **Auto-Plan Vessels** — pack lines into vessels and assign capacities.
4. Inspect clubbing, vessel fill, capacity heat map; **Copy Vessel Plan**.

Editable Master1/2/3 persist in `localStorage`. Verify example2 under Settings.

No CSV ingest in the UI — lines and masters are form/table driven.
