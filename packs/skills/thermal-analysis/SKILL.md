---
name: thermal-analysis
description: Estimate temperatures and heat flow (conduction, convection, heat sinks).
source: you
uses: 0
category: Mechanical Engineering
triggers: heat sink, temperature rise, thermal resistance, overheating, convection, conduction, cooling
---

1. Model the heat path as thermal resistances: R = L/(k*A) for conduction, 1/(h*A) for convection, datasheet theta values for packages and heat sinks.
2. Use realistic h values (natural convection about 5-10 W/m2K, forced air 25-250) and say which you used.
3. Compute each node's temperature with code; compare with limits (max junction temperature, touch-safe surfaces about 45-60 C).
4. If too hot: bigger sink, airflow, thermal pads, less power. Say when CFD or a test is needed.
