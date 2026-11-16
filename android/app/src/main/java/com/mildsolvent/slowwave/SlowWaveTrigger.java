package com.mildsolvent.slowwave;

/**
 * Hook for a future EEG headband (closed loop, like the MIT study).
 *
 * A headband driver that detects the up-phase of a slow wave in real time calls
 * {@link #upPhase()}. While a night is running in "eeg" mode, SleepService then plays a pair
 * of bursts right away instead of following the timed pattern. Nothing calls this yet:
 * see docs/EEG.md for what a driver needs to do.
 */
public final class SlowWaveTrigger {
    /** Play a burst pair now, if a night is running. Safe to call from any thread. */
    public static void upPhase() { SleepService.requestTriggeredPair(); }

    private SlowWaveTrigger() {}
}
