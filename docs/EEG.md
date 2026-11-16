# EEG headband hook (future)

The study worked because the sound was closed-loop: EEG detected each slow wave in real time and
the burst landed on its up-phase. With a consumer EEG headband (Muse S, Dreem-style bands,
OpenBCI) the app could try the same.

## What exists

- `SlowWaveTrigger.upPhase()` (Android): call it when a slow-wave up-phase is predicted. During a
  night started with `mode: "eeg"`, `SleepService` plays a pair of bursts right away (the same
  50 ms bursts, 1 interval apart) instead of the timed pattern. Calls outside a night are ignored.
- The UI's config object accepts `mode` (`"timed"` default, `"eeg"`). There is no UI switch yet.

## What a driver needs

1. Stream EEG from the headband (BLE). Frontal channels, at least 128 Hz.
2. Band-pass 0.5 to 4 Hz, detect a negative half-wave below about -40 µV (adjust per device),
   then predict the next positive peak (typically 400 to 600 ms later) and call `upPhase()` so the
   sound arrives on it. Account for Bluetooth and audio output latency (measure it).
3. Only stimulate in N2/N3 sleep: gate on a simple sleep-stage estimate, and pause for a few
   seconds after any arousal (alpha/EMG burst).
4. Leave a few seconds between pairs (closed-loop studies typically paused about 2.5 s).

None of this is implemented. It's a hook, not a feature.
