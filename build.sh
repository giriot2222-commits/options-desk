#!/usr/bin/env bash
# Local build (needs Node 18+, JDK 17, Android SDK with ANDROID_HOME set)
set -e
npm install
[ -d android ] || npx cap add android
npx cap sync android
cd android && ./gradlew assembleDebug
echo "APK: android/app/build/outputs/apk/debug/app-debug.apk"
