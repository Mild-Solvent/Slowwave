package com.mildsolvent.slowwave;

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
import java.util.Date;

/**
 * Plays one night: optional fading pink hiss while falling asleep, then soft 50 ms pink noise
 * bursts in the burst window, then stops itself. Runs as a foreground media service with a
 * partial wake lock so it keeps going with the screen off.
 *
 * Timing is driven by the audio sample clock: the thread writes a continuous stream (mostly
 * silence) to an AudioTrack, so every burst lands exactly where the plan says.
 */
public class SleepService extends Service {
    static final String ACTION_STOP = "com.mildsolvent.slowwave.STOP";
    private static final String CHANNEL = "night";
    private static final int NOTIF_ID = 7;
    static final String PREFS = "slowwave";

    // ----- shared night state (one night at a time) -----
    private static final Object LOCK = new Object();
    private static JSONObject cfg;              // settings from the UI
    private static long startWall, burstStartWall, burstEndWall;
    private static boolean sham;               // blind test: silent night
    private static volatile boolean running;   // prepared or playing
    private static volatile boolean stopFlag;
    private static volatile int blocks;
    private static volatile long pendingPair = -1; // EEG hook: >=0 means "play a pair now"
    private static Thread audioThread;

    /** Called by the Bridge (binder thread). Sets up the night synchronously so status() is right away correct. */
    static JSONObject prepare(Context ctx, JSONObject c) throws JSONException {
        synchronized (LOCK) {
            if (running) finish(ctx, "stopped", System.currentTimeMillis());
            cfg = c;
            startWall = System.currentTimeMillis();
            burstStartWall = startWall + Math.round(c.optDouble("delayMin", 30) * 60_000L);
            burstEndWall = burstStartWall + Math.round(c.optDouble("windowMin", 180) * 60_000L);
            sham = c.optBoolean("blind", false) && Math.random() < 0.5;
            blocks = 0;
            stopFlag = false;
            running = true;
            JSONObject active = snapshot("active");
            prefs(ctx).edit().putString("active", active.toString()).apply();
            return plan();
        }
    }

    static JSONObject plan() throws JSONException {
        return new JSONObject().put("start", startWall).put("burstStart", burstStartWall).put("burstEnd", burstEndWall);
    }

    private static JSONObject snapshot(String endedBy) throws JSONException {
        return new JSONObject().put("start", startWall).put("plan", plan()).put("cfg", cfg)
                .put("sham", sham).put("endedBy", endedBy).put("platform", "android");
    }

    /** Status for the UI. If the app was killed mid-night, reports it once as interrupted. */
    static JSONObject status(Context ctx) throws JSONException {
        synchronized (LOCK) {
            if (running) {
                long now = System.currentTimeMillis();
                JSONObject s = new JSONObject().put("plan", plan()).put("cfg", cfg)
                        .put("state", now < burstStartWall ? "waiting" : "bursting");
                s.put("blocks", sham ? JSONObject.NULL : blocks);
                return s;
            }
            String active = prefs(ctx).getString("active", null);
            if (active != null) {
                // process died during a night: record what we know
                JSONObject a = new JSONObject(active);
                a.put("end", System.currentTimeMillis()).put("endedBy", "interrupted").put("blocks", 0);
                prefs(ctx).edit().remove("active").putString("last", a.toString()).apply();
                return new JSONObject().put("state", "idle").put("interrupted", true);
            }
            return new JSONObject().put("state", "idle");
        }
    }

    /** Ends the night and writes the morning summary. Idempotent. */
    static void finish(Context ctx, String endedBy, long at) {
        synchronized (LOCK) {
            if (!running) return;
            running = false;
            stopFlag = true;
            try {
                JSONObject last = snapshot(endedBy).put("end", at).put("blocks", sham ? 0 : blocks);
                prefs(ctx).edit().remove("active").putString("last", last.toString()).apply();
            } catch (JSONException ignored) { }
        }
    }

    static void stopNight(Context ctx) {
        finish(ctx, "stopped", System.currentTimeMillis());
        Intent i = new Intent(ctx, SleepService.class).setAction(ACTION_STOP);
        try { ctx.startService(i); } catch (Exception ignored) { }
    }

    static void requestTriggeredPair() { if (running) pendingPair = 0; }

    static SharedPreferences prefs(Context ctx) { return ctx.getSharedPreferences(PREFS, MODE_PRIVATE); }

    // ----- service -----
    private PowerManager.WakeLock wakeLock;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundCompat();
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            finish(this, "stopped", System.currentTimeMillis());
            shutdown();
            return START_NOT_STICKY;
        }
        if (!running) { shutdown(); return START_NOT_STICKY; }
        long total = burstEndWall - System.currentTimeMillis() + 10 * 60_000L;
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "slowwave:night");
        wakeLock.acquire(Math.max(60_000L, total));
        if (audioThread == null || !audioThread.isAlive()) {
            audioThread = new Thread(this::play, "slowwave-audio");
            audioThread.setPriority(Thread.MAX_PRIORITY);
            audioThread.start();
        }
        return START_NOT_STICKY;
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
        final long fadeOutN = Math.min(120L * R, burstStartN), fadeInN = 3L * R;
        final boolean eeg = "eeg".equals(c.optString("mode", "timed"));

        float[][] bank = new float[8][];
        for (int k = 0; k < bank.length; k++) bank[k] = Engine.renderBurst();
        Engine.Pink hiss = new Engine.Pink();

        int minBuf = AudioTrack.getMinBufferSize(R, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioTrack track = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(R).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(Math.max(minBuf, R / 5 * 2))
                .setTransferMode(AudioTrack.MODE_STREAM).build();
        track.play();

        final int CH = R / 20; // 50 ms chunks
        short[] buf = new short[CH];
        long n = 0;
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
        if (!stopFlag) finish(this, endedBy, System.currentTimeMillis());
        shutdown();
    }

    private void shutdown() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Night", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shows while a night is running");
            ch.setSound(null, null);
            ch.enableVibration(false);
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, SleepService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        DateFormat tf = android.text.format.DateFormat.getTimeFormat(this);
        String text = running ? "Soft bursts " + tf.format(new Date(burstStartWall)) + " to " + tf.format(new Date(burstEndWall)) : "Stopping";
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_wave)
                .setContentTitle("Slowwave night")
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
                .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTIF_ID, n);
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
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
            AudioTrack t = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(R).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(total * 2)
                    .setTransferMode(AudioTrack.MODE_STATIC).build();
            t.write(pcm, 0, total);
            t.play();
            try { Thread.sleep(total * 1000L / R + 300); } catch (InterruptedException ignored) { }
            t.release();
        }, "slowwave-test").start();
    }
}
