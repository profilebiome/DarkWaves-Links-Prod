package me.profilebio.darkwaves;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * DarkWaves en Android.
 *
 * 1. FLAG_SECURE: el SISTEMA OPERATIVO pone la ventana en negro en cualquier
 *    captura o grabación de pantalla (igual que Telegram en chats secretos).
 * 2. Selector de archivos (onShowFileChooser) para poder subir música desde el
 *    panel dentro de la app.
 */
public class MainActivity extends Activity {

    private static final String SITE = "https://josspreview.profilebio.me/?v=1.8";
    private static final int REQUEST_FILE = 1001;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        // Bloqueo del sistema: sin capturas y sin grabación de pantalla.
        getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE
        );

        web = new WebView(this);
        setContentView(web);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setWebViewClient(new WebViewClient());

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params
            ) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                }
                fileCallback = callback;

                try {
                    // Selector de audio hecho a mano: es lo que funciona en
                    // todos los Android (params.createIntent() falla en varios).
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("audio/*");
                    if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    }
                    if (intent.resolveActivity(getPackageManager()) == null) {
                        intent.setType("*/*");
                    }
                    startActivityForResult(Intent.createChooser(intent, "Elige el audio"), REQUEST_FILE);
                    return true;
                } catch (Exception error) {
                    // Si el móvil no tiene selector de audio, se abre uno genérico.
                    try {
                        Intent fallback = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                        fallback.addCategory(Intent.CATEGORY_OPENABLE);
                        fallback.setType("*/*");
                        startActivityForResult(fallback, REQUEST_FILE);
                        return true;
                    } catch (Exception ignored) {
                        fileCallback = null;
                        return false;
                    }
                }
            }
        });

        web.setBackgroundColor(0xFF05070D);

        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl(SITE);
        }
    }

    /** Resultado del selector: se lo devolvemos al panel para que suba la pista. */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int index = 0; index < count; index += 1) {
                        results[index] = data.getClipData().getItemAt(index).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{ data.getData() };
                }
            }
            if (fileCallback != null) {
                fileCallback.onReceiveValue(results);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
