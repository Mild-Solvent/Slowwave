package com.mildsolvent.slowwave;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.view.WindowManager;
import android.graphics.Color;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

public class MainActivity extends Activity {
    private WebView web;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyAlarmFlags();
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#07080d"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(this), "SlowwaveNative");
        setContentView(web);
        web.loadUrl("file:///android_asset/www/index.html");
    }

    /** While the alarm rings, show over the lock screen and turn the screen on (full-screen alarm notification). */
    @SuppressWarnings("deprecation")
    private void applyAlarmFlags() {
        boolean ringing = SleepService.isRinging();
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(ringing); setTurnScreenOn(ringing); }
        else {
            int f = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON;
            if (ringing) getWindow().addFlags(f); else getWindow().clearFlags(f);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        applyAlarmFlags();
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyAlarmFlags();
        if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('sw-resume'))", null);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.onBack ? window.onBack() : false", v -> {
            if (!"true".equals(v)) MainActivity.super.onBackPressed();
        });
    }
}
