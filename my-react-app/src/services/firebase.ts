import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage"; 

// act as identifier for the app to connect to cloud database
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: "zentravel-c550a.firebaseapp.com",
  projectId: "zentravel-c550a",
  storageBucket: "zentravel-c550a.firebasestorage.app",
  messagingSenderId: "18966002960",
  appId: "1:18966002960:web:17cab74e4880e12ab13995",
  measurementId: "G-50B899Y46W"
};

if (!firebaseConfig.apiKey) {
  console.warn("Firebase API Key is missing! Check your .env file and restart your terminal.");
}

//prevent multiple instances of the app being initialized during development
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
// Export services, so they can be imported and used in other frontend pages
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app); 