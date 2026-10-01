import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { validatePurchase } from './src/validatePurchase.js';
export { onEntitlementWritten, onStudentCreated } from './src/entitlementFanout.js';
export { appStoreServerNotifications } from './src/appStoreServerNotifications.js';
