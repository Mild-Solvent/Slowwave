package com.mildsolvent.slowwave;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/** window.SlowwaveNative: the web UI's handle on the native night engine. */
final class Bridge {
    private final MainActivity act;

    Bridge(MainActivity act) { this.act = act; }

    @JavascriptInterface
    public String start(String cfgJson) {
        try {
            JSONObject plan = SleepService.prepare(act, new JSONObject(cfgJson));
            Intent i = new Intent(act, SleepService.class);
            act.startForegroundService(i);
            askNotificationsOnce();
            return new JSONObject().put("ok", true).put("plan", plan).toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
        }
    }

    @JavascriptInterface
    public void stop() { SleepService.stopNight(act); }

    @JavascriptInterface
    public String status() {
        try { return SleepService.status(act).toString(); }
        catch (Exception e) { return "{\"state\":\"idle\"}"; }
    }

    @JavascriptInterface
    public String test(String cfgJson) {
        try {
            JSONObject c = new JSONObject(cfgJson);
            SleepService.playTest(c);
            Engine.Pattern p = Engine.pattern(c.optString("pattern", "rhythm"));
            return new JSONObject().put("ok", true).put("bursts", p.bursts).put("intervalMs", p.intervalMs).toString();
        } catch (Exception e) { return "{\"ok\":false}"; }
    }

    @JavascriptInterface
    public String peekLastSession() { return SleepService.prefs(act).getString("last", ""); }

    @JavascriptInterface
    public String takeLastSession() {
        String s = SleepService.prefs(act).getString("last", "");
        SleepService.prefs(act).edit().remove("last").apply();
        return s;
    }

    @JavascriptInterface
    public void keepScreenOn(boolean on) {
        act.runOnUiThread(() -> {
            if (on) act.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else act.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    @JavascriptInterface
    public String version() { return BuildConfig.VERSION_NAME; }

    private void askNotificationsOnce() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (act.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        if (SleepService.prefs(act).getBoolean("askedNotif", false)) return;
        SleepService.prefs(act).edit().putBoolean("askedNotif", true).apply();
        act.runOnUiThread(() -> act.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1));
    }
}
