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
    private var contentOffsetObservation: NSKeyValueObservation?

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(RebootCheckPlugin())
        bridge?.registerPluginInstance(RefundPlugin())

        // Nothing in this app scrolls or lays out sideways. alwaysBounceHorizontal
        // = false (below) rules out elastic rubber-banding, and src/styles/
        // theme.css's overflow-x: hidden rules out DOM-level horizontal
        // overflow — neither stopped a reported, persistent (non-bouncing)
        // horizontal content shift of up to ~165px on the Dashboard page in
        // build 10, confirmed from a screen recording via frame-by-frame
        // analysis: the shift held steady rather than springing back, and
        // on-screen elements stayed the same size (ruling out pinch-zoom,
        // which Capacitor's own WebViewDelegationHandler disables anyway —
        // see scrollViewWillBeginZooming there). Exact trigger unconfirmed
        // (candidates: WKWebView's own edge-swipe-to-go-back gesture
        // recognizer misfiring against a single-page app with no real
        // in-WebView navigation history to reveal; or a transient
        // scrollView.contentSize miscalculation). Rather than keep chasing
        // which one it is, this enforces the actual invariant directly:
        // nothing in this app is ever supposed to be horizontally
        // scrolled, at all, so pin contentOffset.x to 0 unconditionally,
        // for any reason, the instant it changes. KVO rather than
        // becoming the scrollView's delegate — Capacitor's own bridge sets
        // that to its internal WebViewDelegationHandler (see
        // CAPBridgeViewController.swift), and overwriting it would silently
        // break whatever Capacitor relies on that for (it doesn't implement
        // scrollViewDidScroll itself, but observing is still the
        // non-destructive way to add behavior here).
        if let scrollView = webView?.scrollView {
            contentOffsetObservation = scrollView.observe(\.contentOffset, options: [.new]) { scrollView, change in
                guard let offset = change.newValue, offset.x != 0 else { return }
                scrollView.contentOffset = CGPoint(x: 0, y: offset.y)
            }
        }
        webView?.scrollView.alwaysBounceHorizontal = false

        // Without this, only a Debug build run from Xcode over a cable is
        // visible in Safari → Develop — a real TestFlight/Release build's
        // WKWebView is invisible to the remote inspector by default, which
        // is what made it impossible to pull a telematics capture CSV off a
        // real device during real-world road testing (2026-10-02). Requires
        // physical access to the device AND a Mac it's already paired with
        // (Settings → Safari → Advanced → Web Inspector must also be on, on
        // the phone) — the same bar as plugging it in at all, not a remote
        // attack surface, but the owner still wants it off the one build
        // that's actually submitted for public release, not just every
        // Release-configuration build (TestFlight and the public release
        // ARE the same build type to Xcode — Apple gives no "this one's
        // going public" flag to key off, so that one build has to be the
        // single manual exception).
        //
        // INSPECTABLE_BUILD is a SWIFT_ACTIVE_COMPILATION_CONDITIONS entry
        // on the App target's Release config (project.pbxproj) — present by
        // default, so every ordinary TestFlight build stays inspectable.
        // Before archiving THE build that gets submitted for App Store
        // review: Xcode → App target → Build Settings → Swift Compiler —
        // Custom Flags → Active Compilation Conditions (Release) → remove
        // INSPECTABLE_BUILD, archive, submit, then put it back for the next
        // round of TestFlight iteration. Easy to forget — ask me to do this
        // step when that day comes and I'll handle the flag and the
        // re-archive.
        #if INSPECTABLE_BUILD
        if #available(iOS 16.4, *) {
            webView?.isInspectable = true
        }
        #endif
    }
}
