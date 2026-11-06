# Scientific simulation engine

This module provides deterministic one-dimensional Newtonian mechanics for two
explicit models: a constant applied force and an ideal undamped harmonic spring.
The solver uses adaptive velocity-Verlet step doubling, typed quantity
dimensions, SI conversion, configurable error tolerances, and hard step and
iteration budgets. Instrument observations expose time, position, velocity,
acceleration, mechanical energy, and uncertainty status.

For constant force, state uncertainty uses first-order propagation for
independent Gaussian input uncertainties in mass, force, initial position, and
initial velocity. For the spring model, uncertainty is explicitly
`NOT_ASSESSED_MODEL_DERIVATIVE_UNAVAILABLE`; it is not fabricated as zero.
Every result carries `DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE`.

`MediaSimulationContracts.RunRequest` is the typed runtime boundary for model
parameters, initial state, SI-compatible quantities, measurement uncertainty,
and solver policy. `PhysicalSimulation.run` returns `COMPLETED`, `ABSTAINED`
(bounded solver limit), or `INVALID_INPUT`; failures carry no partial trace.
Completed traces include typed SI observables and uncertainty status and are
always labeled `DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE`.

This remains a local numerical engine only. It is not wired to a Media project,
durable job, UI, or measurement device. `SimulationSemanticValidator` separately
checks exact versioned pass inputs and declared invariants; successful synthetic
solver tests do not qualify a model, validate real-world measurements, or make a
domain-owner conclusion. The engine supports only the two declared models.
