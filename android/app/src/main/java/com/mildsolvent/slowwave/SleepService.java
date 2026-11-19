package com.mildsolvent.slowwave;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONException;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.Calendar;
import java.util.Date;

/**
 * Plays one session (a night or a nap): optional fading pink hiss while falling asleep, then soft
 * 50 ms pink noise bursts in the burst window, then silence. If the session has an alarm, a real
 * Android alarm clock (AlarmManager.setAlarmClock, fires in Doze) starts the wake-up chimes on the
 * alarm stream; otherwise the service stops itself after the bursts.
 *
 * Runs as a foreground media service with a partial wake lock while it plays, so it keeps going with
 * the screen off. Timing is driven by the audio sample clock: the thread writes a continuous stream
 * (mostly silence) to an AudioTrack, so every burst lands exactly where the plan says.
 */
public class SleepService extends Service {
    static final String ACTION_STOP = "com.mildsolvent.slowwave.STOP";
    static final String ACTION_WAKE = "com.mildsolvent.slowwave.WAKE";
    private static final String CHANNEL = "night";
    private static final String CHANNEL_ALARM = "alarm";
    private static final int NOTIF_ID = 7, ALARM_NOTIF_ID = 8; // a fresh id for the alarm so its full-screen intent fires
    static final String PREFS = "slowwave";

    // ----- shared session state (one at a time) -----
    private static final Object LOCK = new Object();
    private static JSONObject cfg;              // settings from the UI
    private static long startWall, burstStartWall, burstEndWall, wakeWall, endWall; // wakeWall 0 = no alarm
    private static boolean sham;               // blind test: silent night
    private static volatile boolean running;   // prepared or playing
    private static volatile boolean stopFlag;
    private static volatile int blocks;
    private static volatile long pendingPair = -1; // EEG hook: >=0 means "play a pair now"
    private static Thread audioThread, alarmThread;

    /** Called by the Bridge (binder thread). Sets up the session synchronously so status() is right away correct. */
    static JSONObject prepare(Context ctx, JSONObject c) throws JSONException {
        synchronized (LOCK) {
            if (running) finish(ctx, "stopped", System.currentTimeMillis());
            cfg = c;
            startWall = System.currentTimeMillis();
            boolean nap = "nap".equals(c.optString("session", "night"));
            long bStart = startWall + Math.round((nap ? c.optDouble("napDelayMin", 10) : c.optDouble("delayMin", 30)) * 60_000L);
            long bEnd, wake = 0;
            if (nap) {
                long len = Math.round(c.optDouble("napMin", 30) * 60_000L);
                wake = bStart + len;
                bEnd = wake - Math.min(5 * 60_000L, len / 6);
            } else {
                bEnd = bStart + Math.round(c.optDouble("windowMin", 180) * 60_000L);
                if (c.optBoolean("alarmOn", false)) {
                    wake = nextClock(startWall, c.optString("alarmTime", "09:30"));
                    bEnd = Math.min(bEnd, wake - 10 * 60_000L);
                }
            }
            if (wake > 0 && bStart > wake) bStart = wake;
            burstStartWall = bStart;
            burstEndWall = Math.max(bStart, bEnd);
            wakeWall = wake;
            endWall = wake > 0 ? wake + Math.round(c.optDouble("alarmMin", 5) * 60_000L) : burstEndWall;
            sham = !nap && c.optBoolean("blind", false) && Math.random() < 0.5;
            blocks = 0;
            stopFlag = false;
            running = true;
            prefs(ctx).edit().putString("active", snapshot("active").toString()).apply();
            if (wakeWall > 0) scheduleAlarm(ctx, wakeWall);
            return plan();
        }
    }

    /** Next time the clock shows hh:mm, at least a minute from t0. Mirror of SW.nextClock. */
    static long nextClock(long t0, String hhmm) {
        int h = 9, m = 30;
        try { String[] p = hhmm.split(":"); h = Integer.parseInt(p[0].trim()); m = Integer.parseInt(p[1].trim()); } catch (Exception ignored) { }
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(t0);
        cal.set(Calendar.HOUR_OF_DAY, h); cal.set(Calendar.MINUTE, m); cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0);
        if (cal.getTimeInMillis() <= t0 + 60_000L) cal.add(Calendar.DAY_OF_MONTH, 1);
        return cal.getTimeInMillis();
    }

    static JSONObject plan() throws JSONException {
        return new JSONObject().put("start", startWall).put("burstStart", burstStartWall).put("burstEnd", burstEndWall)
                .put("wakeAt", wakeWall > 0 ? (Object) wakeWall : JSONObject.NULL).put("end", endWall);
    }

    private static JSONObject snapshot(String endedBy) throws JSONException {
        return new JSONObject().put("start", startWall).put("plan", plan()).put("cfg", cfg)
                .put("sham", sham).put("endedBy", endedBy).put("platform", "android");
    }

    private static String stateAt(long t) {
        if (t >= endWall) return "idle";
        if (wakeWall > 0 && t >= wakeWall) return "waking";
        if (t < burstStartWall) return "waiting";
        if (t < burstEndWall) return "bursting";
        return "quiet";
    }

    static boolean isRinging() { return running && wakeWall > 0 && System.currentTimeMillis() >= wakeWall; }

    /** Bring a session back after the process died (e.g. the alarm fires after Android killed us overnight). */
    private static boolean restore(Context ctx) {
        synchronized (LOCK) {
            if (running) return true;
            String active = prefs(ctx).getString("active", null);
            if (active == null) return false;
            try {
                JSONObject a = new JSONObject(active), p = a.getJSONObject("plan");
                long end = p.optLong("end", p.optLong("burstEnd", 0)), wake = p.isNull("wakeAt") ? 0 : p.optLong("wakeAt", 0);
                if (wake <= 0 || System.currentTimeMillis() >= end) return false;
                cfg = a.getJSONObject("cfg");
                startWall = a.getLong("start");
                burstStartWall = p.getLong("burstStart");
                burstEndWall = p.getLong("burstEnd");
                wakeWall = wake;
                endWall = end;
                sham = a.optBoolean("sham", false);
                long upto = Math.min(System.currentTimeMillis(), burstEndWall) - burstStartWall;
                long period = Engine.pattern(cfg.optString("pattern", "rhythm")).periodMs();
                blocks = sham || upto <= 0 ? 0 : (int) ((upto + period - 1) / period);
                stopFlag = false;
                running = true;
                scheduleAlarm(ctx, wakeWall);
                return true;
            } catch (Exception e) { return false; }
        }
    }

    /** Status for the UI. If the app was killed mid-session, reports it once as interrupted. */
    static JSONObject status(Context ctx) throws JSONException {
        synchronized (LOCK) {
            if (!running && prefs(ctx).getString("active", null) != null && restore(ctx)) {
                try { ctx.startForegroundService(new Intent(ctx, SleepService.class)); } catch (Exception ignored) { }
            }
            if (running) {
                long now = System.currentTimeMillis();
                String st = stateAt(now);
                if ("idle".equals(st)) st = wakeWall > 0 ? "waking" : "bursting"; // the audio thread is about to finish
                JSONObject s = new JSONObject().put("plan", plan()).put("cfg", cfg).put("state", st);
                s.put("blocks", sham ? JSONObject.NULL : blocks);
                return s;
            }
            String active = prefs(ctx).getString("active", null);
            if (active != null) {
                // process died during a session: record what we know
                JSONObject a = new JSONObject(active);
                a.put("end", System.currentTimeMillis()).put("endedBy", "interrupted").put("blocks", 0);
                prefs(ctx).edit().remove("active").putString("last", a.toString()).apply();
                cancelAlarm(ctx);
                return new JSONObject().put("state", "idle").put("interrupted", true);
            }
            return new JSONObject().put("state", "idle");
        }
    }

    /** Ends the session and writes the morning summary. Idempotent. */
    static void finish(Context ctx, String endedBy, long at) {
        synchronized (LOCK) {
            if (!running) return;
            running = false;
            stopFlag = true;
            cancelAlarm(ctx);
            try {
                JSONObject last = snapshot(endedBy).put("end", at).put("blocks", sham ? 0 : blocks);
                prefs(ctx).edit().remove("active").putString("last", last.toString()).apply();
            } catch (JSONException ignored) { }
        }
    }

    private static String stopReason() { return isRinging() ? "woke" : "stopped"; }

    static void stopNight(Context ctx) {
        finish(ctx, stopReason(), System.currentTimeMillis());
        Intent i = new Intent(ctx, SleepService.class).setAction(ACTION_STOP);
        try { ctx.startService(i); } catch (Exception ignored) { }
    }

    static void requestTriggeredPair() { if (running) pendingPair = 0; }

    static SharedPreferences prefs(Context ctx) { return ctx.getSharedPreferences(PREFS, MODE_PRIVATE); }

    // ----- alarm clock -----
    private static PendingIntent wakeIntent(Context ctx) {
        Intent i = new Intent(ctx, SleepService.class).setAction(ACTION_WAKE);
        return PendingIntent.getForegroundService(ctx, 2, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static void scheduleAlarm(Context ctx, long at) {
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        PendingIntent show = PendingIntent.getActivity(ctx, 3, new Intent(ctx, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        try {
            am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), wakeIntent(ctx));
        } catch (SecurityException e) {
            // exact alarms not allowed: still wake up, maybe a little late
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, wakeIntent(ctx));
        }
    }

    private static void cancelAlarm(Context ctx) {
        try { ctx.getSystemService(AlarmManager.class).cancel(wakeIntent(ctx)); } catch (Exception ignored) { }
    }

    // ----- service -----
    private PowerManager.WakeLock wakeLock;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_WAKE.equals(action) && !running) restore(this);
        startForegroundCompat(ACTION_WAKE.equals(action) || isRinging());
        if (ACTION_STOP.equals(action)) {
            finish(this, stopReason(), System.currentTimeMillis());
            shutdown();
            return START_NOT_STICKY;
        }
        if (!running) { shutdown(); return START_NOT_STICKY; }
        long now = System.currentTimeMillis();
        if (ACTION_WAKE.equals(action) || isRinging()) {
            holdWakeLock(endWall - now + 60_000L);
            lightScreen();
            if (alarmThread == null || !alarmThread.isAlive()) {
                alarmThread = new Thread(this::ring, "slowwave-alarm");
                alarmThread.setPriority(Thread.MAX_PRIORITY);
                alarmThread.start();
            }
        } else if (now < burstEndWall) {
            holdWakeLock(burstEndWall - now + 10 * 60_000L);
            if (audioThread == null || !audioThread.isAlive()) {
                audioThread = new Thread(this::play, "slowwave-audio");
                audioThread.setPriority(Thread.MAX_PRIORITY);
                audioThread.start();
            }
        }
        // else: quiet until the alarm; the alarm clock wakes us, no wake lock needed
        return START_NOT_STICKY;
    }

    private void holdWakeLock(long ms) {
        releaseWakeLock();
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "slowwave:night");
        wakeLock.acquire(Math.max(60_000L, ms));
    }

    /** Turn the screen on when the alarm starts (the full-screen intent then shows the app over the lock screen). */
    @SuppressWarnings("deprecation")
    private void lightScreen() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP | PowerManager.ON_AFTER_RELEASE,
                    "slowwave:alarm-screen").acquire(15_000L);
        } catch (Exception ignored) { }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private static AudioTrack makeTrack(boolean alarm, int bufBytes, int mode) {
        return new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(alarm ? AudioAttributes.USAGE_ALARM : AudioAttributes.USAGE_MEDIA)
                        .setContentType(alarm ? AudioAttributes.CONTENT_TYPE_SONIFICATION : AudioAttributes.CONTENT_TYPE_MUSIC).build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(Engine.RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(bufBytes)
                .setTransferMode(mode).build();
    }

    private static AudioTrack streamTrack(boolean alarm) {
        int R = Engine.RATE;
        int minBuf = AudioTrack.getMinBufferSize(R, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        return makeTrack(alarm, Math.max(minBuf, R / 5 * 2), AudioTrack.MODE_STREAM);
    }

    private void play() {
        JSONObject c; long sStart, bStart, bEnd; boolean silent;
        synchronized (LOCK) { c = cfg; sStart = startWall; bStart = burstStartWall; bEnd = burstEndWall; silent = sham; }
        final int R = Engine.RATE;
        final long burstStartN = (bStart - sStart) * R / 1000, burstEndN = (bEnd - sStart) * R / 1000;
        final Engine.Pattern p = Engine.pattern(c.optString("pattern", "rhythm"));
        final long periodN = p.periodMs() * R / 1000, intervalN = (long) p.intervalMs * R / 1000;
        final int burstLen = R * Engine.BURST_MS / 1000;
        final float bGain = Engine.burstGain(c.optInt("volume", 35));
        final boolean lull = c.optBoolean("lull", false);
        final float hGain = Engine.hissGain(c.optInt("lullVol", 30));
        final long fadeOutN = Math.min(120L * R, burstStartN), fadeInN = Math.min(3L * R, Math.max(1, burstStartN - fadeOutN));
        final boolean eeg = "eeg".equals(c.optString("mode", "timed"));

        float[][] bank = new float[8][];
        for (int k = 0; k < bank.length; k++) bank[k] = Engine.renderBurst();
        Engine.Pink hiss = new Engine.Pink();

        AudioTrack track = streamTrack(false);
        track.play();

        final int CH = R / 20; // 50 ms chunks
        short[] buf = new short[CH];
        // start where the plan is now (0 for a fresh session, later after a restore)
        long n = Math.max(0, (System.currentTimeMillis() - sStart) * R / 1000) / CH * CH;
        float[] cur = bank[0];
        long pairAt = -1;
        String endedBy = "done";
        try {
            while (!stopFlag && n < burstEndN) {
                if (pendingPair >= 0) { pendingPair = -1; if (eeg) pairAt = n; }
                for (int i = 0; i < CH; i++) {
                    long g = n + i;
                    float v = 0f;
                    if (lull && g < burstStartN) {
                        float env = 1f;
                        if (g < fadeInN) env = (float) g / fadeInN;
                        long toBurst = burstStartN - g;
                        if (toBurst < fadeOutN) env *= (float) toBurst / fadeOutN;
                        v += hiss.next() * hGain * env;
                    }
                    if (!silent && !eeg && g >= burstStartN) {
                        long pos = (g - burstStartN) % periodN;
                        long k = pos / intervalN, off = pos % intervalN;
                        if (k < p.bursts && off < burstLen) {
                            if (off == 0) {
                                cur = bank[(int) (Math.random() * bank.length)];
                                if (k == 0) blocks++;
                            }
                            v += cur[(int) off] * bGain;
                        }
                    }
                    if (!silent && pairAt >= 0) {
                        long d = g - pairAt, off = d % intervalN;
                        if (d >= 2 * intervalN) pairAt = -1;
                        else if (off < burstLen) {
                            if (off == 0) { cur = bank[(int) (Math.random() * bank.length)]; if (d == 0) blocks++; }
                            v += cur[(int) off] * bGain;
                        }
                    }
                    buf[i] = Engine.toPcm(v);
                }
                int w = track.write(buf, 0, CH);
                if (w < 0) { endedBy = "interrupted"; break; }
                n += CH;
            }
        } finally {
            try { track.pause(); track.flush(); track.stop(); } catch (Exception ignored) { }
            track.release();
        }
        if (stopFlag) { shutdown(); return; }
        if (wakeWall > 0 && "done".equals(endedBy)) {
            // bursts are over; stay quiet until the alarm clock fires
            if (!isRinging()) releaseWakeLock();
            startForegroundCompat(isRinging());
            return;
        }
        finish(this, endedBy, System.currentTimeMillis());
        shutdown();
    }

    /** The wake-up alarm: soft chimes on the alarm stream, getting louder, until stopped or the alarm time runs out. */
    private void ring() {
        long wake, end;
        synchronized (LOCK) { wake = wakeWall; end = endWall; }
        final int R = Engine.RATE, CH = R / 20;
        final float[] chime = Engine.renderChime();
        final long periodN = (long) Engine.CHIME_PERIOD_MS * R / 1000, durN = (end - wake) * R / 1000;
        long n = Math.max(0, (System.currentTimeMillis() - wake) * R / 1000) / periodN * periodN; // start on a chime
        AudioTrack track = streamTrack(true);
        track.play();
        short[] buf = new short[CH];
        try {
            while (!stopFlag && n < durN) {
                for (int i = 0; i < CH; i++) {
                    long g = n + i, k = g / periodN, off = g % periodN;
                    buf[i] = off < chime.length ? Engine.toPcm(chime[(int) off] * Engine.alarmGain(k * Engine.CHIME_PERIOD_MS)) : 0;
                }
                if (track.write(buf, 0, CH) < 0) break;
                n += CH;
            }
        } finally {
            try { track.pause(); track.flush(); track.stop(); } catch (Exception ignored) { }
            track.release();
        }
        if (!stopFlag) finish(this, "done", System.currentTimeMillis());
        shutdown();
    }

    private void shutdown() {
        releaseWakeLock();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void startForegroundCompat(boolean ringing) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Night", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shows while a night or nap is running");
            ch.setSound(null, null);
            ch.enableVibration(false);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CHANNEL_ALARM) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ALARM, "Alarm", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("The wake-up alarm (the app plays its own sound)");
            ch.setSound(null, null);
            ch.enableVibration(false);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, SleepService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        DateFormat tf = android.text.format.DateFormat.getTimeFormat(this);
        boolean nap = cfg != null && "nap".equals(cfg.optString("session", "night"));
        String title, text;
        if (!running) { title = "Slowwave"; text = "Stopping"; }
        else if (ringing) { title = "Wake up"; text = "Alarm " + tf.format(new Date(wakeWall)) + " · tap Stop"; }
        else {
            title = nap ? "Slowwave nap" : "Slowwave night";
            text = burstEndWall > burstStartWall
                    ? "Soft bursts " + tf.format(new Date(burstStartWall)) + " to " + tf.format(new Date(burstEndWall))
                    : "No bursts";
            if (wakeWall > 0) text += " · alarm " + tf.format(new Date(wakeWall));
        }
        Notification.Builder b = new Notification.Builder(this, ringing ? CHANNEL_ALARM : CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_wave)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, ringing ? "Stop alarm" : "Stop", stop).build());
        if (ringing) {
            b.setCategory(Notification.CATEGORY_ALARM).setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setFullScreenIntent(PendingIntent.getActivity(this, 4, new Intent(this, MainActivity.class),
                            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT), true);
        }
        Notification n = b.build();
        int id = ringing ? ALARM_NOTIF_ID : NOTIF_ID;
        if (Build.VERSION.SDK_INT >= 29) startForeground(id, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(id, n);
        if (ringing) nm.cancel(NOTIF_ID);
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        super.onDestroy();
    }

    /** Test button: one group of bursts at the chosen volume, right now. */
    static void playTest(JSONObject c) {
        new Thread(() -> {
            Engine.Pattern p = Engine.pattern(c.optString("pattern", "rhythm"));
            float g = Engine.burstGain(c.optInt("volume", 35));
            int R = Engine.RATE, intervalN = p.intervalMs * R / 1000;
            int lead = R / 10; // 100 ms of silence so the first burst isn't clipped
            int total = lead + (p.bursts - 1) * intervalN + R * Engine.BURST_MS / 1000 + R / 10;
            short[] pcm = new short[total];
            for (int k = 0; k < p.bursts; k++) {
                float[] b = Engine.renderBurst();
                for (int i = 0; i < b.length; i++) pcm[lead + k * intervalN + i] = Engine.toPcm(b[i] * g);
            }
            AudioTrack t = makeTrack(false, total * 2, AudioTrack.MODE_STATIC);
            t.write(pcm, 0, total);
            t.play();
            try { Thread.sleep(total * 1000L / R + 300); } catch (InterruptedException ignored) { }
            t.release();
        }, "slowwave-test").start();
    }
}
