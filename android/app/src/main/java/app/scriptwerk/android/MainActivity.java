package app.scriptwerk.android;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UsbHostPlugin.class);
        registerPlugin(ElectrumHostPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
