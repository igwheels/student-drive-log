import Capacitor

/**
 * The app's Capacitor bridge view controller, wired up in
 * Base.lproj/Main.storyboard in place of Capacitor's own
 * CAPBridgeViewController.
 *
 * It exists for exactly one reason: to register app-local plugins
 * (RebootCheckPlugin, RefundPlugin). Capacitor 8 auto-registers only the
 * classes named in the generated App/capacitor.config.json
 * `packageClassList`, and `cap sync` rebuilds that list purely from the
 * Capacitor plugins installed under node_modules — an app-local plugin can
 * never appear in it, no matter that its source file is in the App target.
 * With no registration the bridge never injects a PluginHeader for it, and
 * @capacitor/core's registerPlugin() proxy rejects every call with "not
 * implemented" without ever reaching native. That is what made
 * getDeviceBootTime() return null on device and left the reboot half of
 * the biometric session policy inert.
 *
 * capacitorDidLoad() is the hook for this: the bridge exists by then, and
 * the web view has not been loaded yet, so the header is injected before
 * any app JS runs.
 */
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(RebootCheckPlugin())
        bridge?.registerPluginInstance(RefundPlugin())
    }
}
