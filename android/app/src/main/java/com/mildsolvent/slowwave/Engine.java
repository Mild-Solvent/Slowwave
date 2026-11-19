package com.mildsolvent.slowwave;

import java.util.Random;

/** Sound definitions shared by the night service and the Test button. Keep in sync with web/engine-web.js. */
final class Engine {
    static final int RATE = 44100;
    static final int BURST_MS = 50;
    static final int RAMP_MS = 5;

    static final class Pattern {
        final int bursts, intervalMs, restMs;
        Pattern(int bursts, int intervalMs, int restMs) { this.bursts = bursts; this.intervalMs = intervalMs; this.restMs = restMs; }
        long periodMs() { return (long) bursts * intervalMs + restMs; }
    }

    static Pattern pattern(String name) {
        if ("pairs".equals(name)) return new Pattern(2, 1000, 13000);
        return new Pattern(5, 1250, 10000); // "rhythm": 0.8 Hz, slow-oscillation pace
    }

    /** Slider 1..100 to a linear peak gain. 35 is about -47 dBFS, 100 is -12 dBFS. */
    static float burstGain(int v) { return (float) Math.pow(10, (-66 + 0.54 * v) / 20.0); }
    static float hissGain(int v) { return (float) Math.pow(10, (-72 + 0.5 * v) / 20.0); }

    /** Pink noise, Paul Kellet's refined filter, output roughly in [-1, 1]. */
    static final class Pink {
        private final Random rnd = new Random();
        private double b0, b1, b2, b3, b4, b5, b6;
        float next() {
            double w = rnd.nextDouble() * 2 - 1;
            b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
            b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
            b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
            double out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
            b6 = w * 0.115926;
            return (float) (out * 0.11);
        }
    }

    /** One fresh 50 ms pink noise burst with 5 ms raised-cosine ramps, peak-normalised to 1. */
    static float[] renderBurst() {
        int n = RATE * BURST_MS / 1000, ramp = RATE * RAMP_MS / 1000;
        Pink pink = new Pink();
        for (int i = 0; i < 200; i++) pink.next();
        float[] out = new float[n];
        float peak = 1e-9f;
        for (int i = 0; i < n; i++) { out[i] = pink.next(); peak = Math.max(peak, Math.abs(out[i])); }
        for (int i = 0; i < n; i++) {
            double g = 1.0 / peak;
            if (i < ramp) g *= 0.5 - 0.5 * Math.cos(Math.PI * i / ramp);
            else if (i >= n - ramp) g *= 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - i) / ramp);
            out[i] *= (float) g;
        }
        return out;
    }

    /** Alarm: a four-note chime every 4 s, rising from -32 to -10 dBFS over 90 s. Mirror of engine-web.js. */
    static final int CHIME_PERIOD_MS = 4000;
    static float alarmGain(long elapsedMs) { return (float) Math.pow(10, (-32 + 22 * Math.min(1.0, elapsedMs / 90000.0)) / 20.0); }

    static float[] renderChime() {
        double[][] notes = {{523.25, 0}, {659.25, 0.28}, {783.99, 0.56}, {1046.5, 0.84}};
        int n = (int) Math.round(RATE * 2.8);
        float[] out = new float[n];
        for (double[] nt : notes) {
            double f = nt[0], at = nt[1];
            for (int i = (int) Math.round(at * RATE); i < n; i++) {
                double t = (double) i / RATE - at, env = t < 0.008 ? t / 0.008 : Math.exp(-(t - 0.008) / 0.5);
                out[i] += (float) (env * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)));
            }
        }
        float peak = 1e-9f;
        for (float v : out) peak = Math.max(peak, Math.abs(v));
        for (int i = 0; i < n; i++) out[i] /= peak;
        int fade = RATE / 20;
        for (int i = 0; i < fade; i++) out[n - 1 - i] *= (float) i / fade;
        return out;
    }

    static short toPcm(float v) {
        if (v > 1f) v = 1f; else if (v < -1f) v = -1f;
        return (short) Math.round(v * 32767f);
    }

    private Engine() {}
}
