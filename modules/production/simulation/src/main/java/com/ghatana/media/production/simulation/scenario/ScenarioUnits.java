package com.ghatana.media.production.simulation.scenario;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Dimensioned units of the scenario solver. A dimension is the exponent vector (mass, length, time, angle); a unit is a
 * symbol with an exact factor to the SI coherent unit of that dimension. Every quantity is checked against the dimension
 * its field requires and converted at the boundary, so the solver only ever sees SI numbers.
 */
public final class ScenarioUnits {
    private ScenarioUnits() { }

    /** Exponent vector of mass, length, time and angle. */
    public record Dim(int mass, int length, int time, int angle) {
        public static final Dim MASS = new Dim(1, 0, 0, 0);
        public static final Dim LENGTH = new Dim(0, 1, 0, 0);
        public static final Dim TIME = new Dim(0, 0, 1, 0);
        public static final Dim VELOCITY = new Dim(0, 1, -1, 0);
        public static final Dim ACCELERATION = new Dim(0, 1, -2, 0);
        public static final Dim FORCE = new Dim(1, 1, -2, 0);
        public static final Dim SPRING_CONSTANT = new Dim(1, 0, -2, 0);
        public static final Dim LINEAR_DAMPING = new Dim(1, 0, -1, 0);
        public static final Dim QUADRATIC_DRAG = new Dim(1, -1, 0, 0);
        public static final Dim ENERGY = new Dim(1, 2, -2, 0);
        public static final Dim ANGLE = new Dim(0, 0, 0, 1);

        @Override public String toString() {
            StringBuilder out = new StringBuilder();
            append(out, "M", mass);
            append(out, "L", length);
            append(out, "T", time);
            append(out, "A", angle);
            return out.isEmpty() ? "1" : out.toString();
        }

        private static void append(StringBuilder out, String symbol, int exponent) {
            if (exponent == 0) return;
            if (!out.isEmpty()) out.append('*');
            out.append(symbol).append('^').append(exponent);
        }
    }

    /** A unit symbol, its dimension and its exact factor to SI. */
    public record Unit(String symbol, Dim dimension, double toSi) { }

    private static final Map<String, Unit> TABLE = new LinkedHashMap<>();

    private static void unit(String symbol, Dim dimension, double factor) {
        TABLE.put(symbol, new Unit(symbol, dimension, factor));
    }

    static {
        unit("kg", Dim.MASS, 1.0);
        unit("g", Dim.MASS, 0.001);
        unit("m", Dim.LENGTH, 1.0);
        unit("km", Dim.LENGTH, 1000.0);
        unit("cm", Dim.LENGTH, 0.01);
        unit("mm", Dim.LENGTH, 0.001);
        unit("s", Dim.TIME, 1.0);
        unit("ms", Dim.TIME, 0.001);
        unit("m/s", Dim.VELOCITY, 1.0);
        unit("km/h", Dim.VELOCITY, 1000.0 / 3600.0);
        unit("cm/s", Dim.VELOCITY, 0.01);
        unit("m/s^2", Dim.ACCELERATION, 1.0);
        unit("N", Dim.FORCE, 1.0);
        unit("mN", Dim.FORCE, 0.001);
        unit("kN", Dim.FORCE, 1000.0);
        unit("N/m", Dim.SPRING_CONSTANT, 1.0);
        unit("kg/s", Dim.LINEAR_DAMPING, 1.0);
        unit("N*s/m", Dim.LINEAR_DAMPING, 1.0);
        unit("kg/m", Dim.QUADRATIC_DRAG, 1.0);
        unit("J", Dim.ENERGY, 1.0);
        unit("kJ", Dim.ENERGY, 1000.0);
        unit("rad", Dim.ANGLE, 1.0);
        unit("deg", Dim.ANGLE, Math.PI / 180.0);
    }

    /** All supported unit symbols with their dimension, for capability listings. */
    public static Map<String, String> catalog() {
        Map<String, String> out = new LinkedHashMap<>();
        TABLE.forEach((symbol, unit) -> out.put(symbol, unit.dimension().toString()));
        return out;
    }

    public static Unit lookup(String symbol, String path) {
        Unit unit = symbol == null ? null : TABLE.get(symbol);
        if (unit == null) {
            throw new ScenarioException(ScenarioException.Kind.UNIT_MISMATCH, path,
                    "unknown unit symbol", Map.of("received", String.valueOf(symbol), "supportedUnits", TABLE.keySet().toString()));
        }
        return unit;
    }

    /** Converts {@code value unit} to SI, refusing a unit of another dimension and any non-finite result. */
    public static double toSi(double value, String unitSymbol, Dim expected, String path) {
        Unit unit = lookup(unitSymbol, path + ".unit");
        if (!unit.dimension().equals(expected)) {
            throw new ScenarioException(ScenarioException.Kind.UNIT_MISMATCH, path + ".unit",
                    "unit " + unit.symbol() + " has dimension " + unit.dimension() + " but " + expected + " is required",
                    Map.of("expected", expected.toString(), "received", unit.dimension().toString(), "unit", unit.symbol()));
        }
        if (!Double.isFinite(value)) {
            throw new ScenarioException(ScenarioException.Kind.NON_FINITE, path + ".value", "value must be finite");
        }
        double si = value * unit.toSi();
        if (!Double.isFinite(si)) {
            throw new ScenarioException(ScenarioException.Kind.NON_FINITE, path + ".value",
                    "value overflows the SI conversion");
        }
        if (value != 0.0 && si == 0.0) {
            throw new ScenarioException(ScenarioException.Kind.NON_FINITE, path + ".value",
                    "value underflows the SI conversion");
        }
        return si;
    }
}
