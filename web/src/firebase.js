import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const isConfigured = Object.values(firebaseConfig).every(Boolean);
const app = isConfigured ? (getApps().length ? getApp() : initializeApp(firebaseConfig)) : null;
export const auth = app ? getAuth(app) : null;
const functions = app ? getFunctions(app) : null;
export const call = (name, data) => httpsCallable(functions, name)(data).then((result) => result.data);
