# Storyroom for Android

An offline-first audiobook player built with Expo and React Native. This is an isolated Android app in `react-native-app`; the existing desktop app remains unchanged.

The app targets Expo SDK 57 for compatibility with Expo Go clients supporting SDK 57.

## Run

1. Install Node.js and Android Studio, including an Android SDK and emulator (or connect an Android device with USB debugging enabled).
2. From this folder, install dependencies and start the Android app:

   ```powershell
   npm install
   npm run android
   ```

   To start Expo without launching a device, run `npm start`.

Expo Go supports foreground playback, but it cannot install this project's Android playback service or lock-screen controls. To use background playback and lock-screen controls, build and install a custom native development app after configuring the Android SDK:

```powershell
npx expo prebuild --platform android
npx expo run:android
```

Then start Metro with `npx expo start --dev-client` and open the installed Storyroom development app. Rebuild the native app after changing Expo config plugins. When running in Expo Go, lock-screen activation is disabled to avoid native service-binding errors.

## Current features

- Import audio files from Android's system document picker
- Plays locally stored audio, including M4B where supported by the Android device
- Saves the library, listening position, recent activity, bookmarks, queue, and playback speed in a local SQLite database
- Background audio playback and lock-screen media controls
- Search, sort, edit titles/authors, and select replacement cover artwork
- Reads embedded title, author, duration, cover art, and chapters when supported by the audio metadata
- Chapter list and chapter-aware previous/next playback controls
- Playback speed, seek slider, skip controls, queue, and library navigation
- Imported media and selected cover art are copied into the app's private documents folder so Android picker access remains available after restart

Imported files occupy additional device storage. Removing a book from the library does not delete its copied audio. If an audio format has no readable embedded tags, its title initially uses the file name and details can be edited in the app.

## Build an APK

Configure the Android SDK, then build the installable ARM64 release-variant APK from PowerShell:

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
npx expo prebuild --platform android
Push-Location android
.\gradlew.bat app:assembleRelease -PreactNativeArchitectures=arm64-v8a
Pop-Location
```

The installable APK is `android\app\build\outputs\apk\release\app-release.apk`. Install it by copying it to your Android device and opening it, or with `adb install -r android\app\build\outputs\apk\release\app-release.apk`. This release build is signed with the local Android debug key for sideloading. Use a private release keystore for production distribution.

Storyroom's full-bleed launcher artwork is in `assets\icon.png`; the adaptive Android foreground and monochrome artwork are inset to stay inside launcher safe margins in `assets\android-icon-foreground.png` and `assets\android-icon-monochrome.png`. Regenerate the native project after changing these assets or `app.json`. Increment `expo.android.versionCode` when preparing an APK to install as an update.
