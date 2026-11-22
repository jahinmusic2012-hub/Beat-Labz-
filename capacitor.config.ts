import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.jahinmusic.beatlabz',
  appName: 'BEAT LABZ',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    allowNavigation: [
      '*.firebaseapp.com',
      '*.googleapis.com',
      'accounts.google.com',
      'wa.me',
    ],
  },
  plugins: {
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0A0B0E',
      overlaysWebView: false,
    },
  },
};

export default config;
