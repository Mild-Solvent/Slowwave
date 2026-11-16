# Slowwave on iPad / iPhone

## Install (web app)

1. Open the Slowwave web address in **Safari**.
2. Share → **Add to Home Screen**. It opens full screen like an app and works offline after the
   first visit.
3. Turn the iPad's volume to a normal level, then use **Test** in the app to set the burst volume
   so you can only just hear it lying down.

## Will it keep playing when the iPad is locked?

The whole night is scheduled up front on the Web Audio clock, the app asks iOS for a "playback"
audio session, and it keeps a silent media track running, so nothing has to run in the background.
iOS may still pause web audio when the screen locks. So:

- **Keep screen on** is on by default: the night screen is black and dim. Turn brightness all the
  way down, or lay the iPad face down.
- The app watches its own audio clock. If iOS paused the sound, the night screen and the morning
  card tell you at what time it stopped.

Try one night with Keep screen on off: if the morning card does not say the sound was paused,
locking is fine on your iPad.

## Native iOS app instead?

Needs a Mac with Xcode plus either a paid Apple developer account ($99/year, app lasts a year) or
a free one (the sideloaded app expires every 7 days and must be reinstalled from the Mac). Only
worth it if the web app turns out to stop when locked even with the screen on.
