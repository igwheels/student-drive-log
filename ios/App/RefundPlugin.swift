import Foundation
import Capacitor
import StoreKit

/**
 * Refund — a tiny app-local Capacitor plugin wrapping StoreKit 2's
 * Transaction.beginRefundRequest(for:in:), which presents Apple's own
 * native refund-request sheet. There is no equivalent in
 * @capgo/native-purchases (or any Capacitor IAP plugin — this is a
 * StoreKit-only API, Android has no in-app refund flow at all; Play
 * purchases are refunded through the Play Store app itself).
 *
 * Registered the same way as RebootCheckPlugin — see MainViewController's
 * doc comment for why that registration step is required at all.
 *
 * This presents Apple's UI and nothing else: approval/denial and the
 * resulting REFUND notification are entirely Apple's doing afterwards (see
 * functions/src/appStoreServerNotifications.js on the server side, which is
 * what actually revokes the entitlement once Apple approves it — this
 * plugin never touches Firestore).
 */
@objc(RefundPlugin)
public class RefundPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RefundPlugin"
    public let jsName = "Refund"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestRefund", returnType: CAPPluginReturnPromise)
    ]

    @objc func requestRefund(_ call: CAPPluginCall) {
        guard let transactionIdString = call.getString("transactionId"), let transactionId = UInt64(transactionIdString) else {
            call.reject("A numeric transactionId is required.")
            return
        }

        Task { @MainActor in
            guard let scene = self.bridge?.viewController?.view.window?.windowScene else {
                call.reject("Could not find the app's window to present the refund sheet in.")
                return
            }

            do {
                let status = try await Transaction.beginRefundRequest(for: transactionId, in: scene)
                switch status {
                case .success:
                    call.resolve(["status": "success"])
                case .userCancelled:
                    call.resolve(["status": "userCancelled"])
                @unknown default:
                    call.resolve(["status": "unknown"])
                }
            } catch {
                call.reject("Refund request failed: \(error.localizedDescription)")
            }
        }
    }
}
