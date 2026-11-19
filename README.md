# Slowwave

Soft 50 ms pink noise bursts during the first hours of sleep. A self-experiment inspired by the
MIT study (Levitt, Lewis et al., *Science Translational Medicine*, Sep 2026), where pink noise
bursts timed by EEG to the peaks of deep-sleep slow waves made those waves, and the CSF flow that
follows them, stronger.

## Read this first

The study's effect depends on closed-loop timing: EEG finds each slow wave and the sound lands
on its peak. A phone has no EEG, so this app **cannot** do that. It approximates:

- the same sound: 50 ms pink noise, 5 ms ramps, quiet by default (about -47 dBFS at volume 35);
- only in a burst window after a fall-asleep delay (default 30 min, then 3 h), where most deep
  sleep usually is;
- **Rhythm** pattern: 5 bursts at 0.8 Hz (slow-oscillation pace), 10 s rest. **Pairs**: 2 bursts
  1 s apart, 13 s rest;
- then silence and an automatic stop. No all-night noise: a separate study found continuous
  pink noise reduced REM sleep.

It's a fun experiment, not a treatment. Blind test mode makes each night randomly real or silent
and only reveals which after you rate the morning, so a placebo effect can't fool you.

## Nap mode and alarms (0.2.0)

- **Night / Nap** switch at the top. Every timer is a slider: fall-asleep time (0 to 2 h for a
  night, 0 to 45 min for a nap), burst window (30 min to 6 h), nap length (10 min to 3 h).
- **Nap**: bursts play during the nap and stop a few minutes (up to 5) before the end, then a gentle
  alarm wakes you. Nap length counts from when you're expected to be asleep.
- **Night alarm**: optional wake-up time. Bursts stop at least 10 min before it.
- The alarm is a soft four-note chime every 4 s that rises from -32 to -10 dBFS over 90 s and gives
  up after 5 min. On Android it's a real alarm clock (`AlarmManager.setAlarmClock`, fires in Doze),
  plays on the alarm stream (alarm volume, not media volume) and shows over the lock screen. On
  iPad it's scheduled on the Web Audio clock, so keep the screen on.

## Layout

```
web/       the UI (HTML/CSS/JS), also the iPad/iPhone web app (PWA)
  engine-web.js   pattern + volume definitions, browser audio engine
  app.js          UI
android/   Java WebView shell + native sound engine
  SleepService.java   foreground media service, AudioTrack, sample-clock timing
  Engine.java         pink noise + burst generator (mirror of engine-web.js)
  SlowWaveTrigger.java  hook for a future EEG headband (docs/EEG.md)
tools/ui-test.js   headless phone-size test of the web UI
```

On Android the screen can be off all night: the sound runs in a foreground service with a
partial wake lock and its own notification (with a Stop button). The web version schedules the
whole night on the Web Audio clock up front; if the device suspends audio anyway it notices and
tells you in the morning.

## Build

Android (JDK 17+, Android SDK 35):

```
cd android
./gradlew assembleDebug                      # debug APK
SLOWWAVE_KEYSTORE_PROPS=/path/keystore.properties ./gradlew assembleRelease
```

The web UI is copied into the APK from `../web` at build time. The release key lives outside the
repo and must be the same for every release.

Web app: serve `web/` over HTTPS. On iPad: open it in Safari, Share → Add to Home Screen.

Tests: `node tools/ui-test.js [outdir]` (needs Playwright).

## iOS

A native iOS app would need a Mac with Xcode and an Apple developer account ($99/year, or a free
account where sideloaded apps expire after 7 days). The web app is the low-friction route: see
docs/IPAD.md.
