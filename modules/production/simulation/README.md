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

This is a local numerical engine only. It is not wired to a Media project,
runtime-contract operation, durable job, UI, or measurement device. It does not
admit simulation semantics beyond these two models, and its outputs are not
scientific instrument measurements or domain-owner validated conclusions.
