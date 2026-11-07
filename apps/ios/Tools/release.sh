#!/bin/bash
# Archive, export and upload the iPhone app to TestFlight (Internal group).
# It never submits for App Store review; that stays a separate, guarded
# `asc review submit` after a real-device launch (see docs/app-store.md).
#
# usage: Tools/release.sh <version> <build> [what-to-test]
# Needs ~/.config/skill-studio-release/release.env (App Store Connect API key,
# Clerk and relay values) and Xcode 27.2. Output goes to build/release/<version>-<build>.
set -euo pipefail

V=${1:?usage: Tools/release.sh <version> <build> [what-to-test]}
B=${2:?usage: Tools/release.sh <version> <build> [what-to-test]}
NOTES=${3:-}
APP_ID=6824245458
TEAM_ID=NMCB2JZ7QG
INTERNAL_GROUP=dd7afb46-e800-4b02-a3a5-48a12dc89140

cd "$(dirname "$0")/.."
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode-27.2.app/Contents/Developer}
set -a; . ~/.config/skill-studio-release/release.env; set +a
export STUDIO_CLERK_OAUTH_PROVIDERS="${STUDIO_CLERK_OAUTH_PROVIDERS:-$(gh variable get STUDIO_CLERK_OAUTH_PROVIDERS -R anton-abyzov/specwithcode)}"
export STUDIO_APPLE_TEAM_ID=$TEAM_ID STUDIO_CODE_SIGN_ENTITLEMENTS=Config/Connect.entitlements
unset GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
AUTH=(-authenticationKeyPath "$APPLE_API_KEY_PATH" -authenticationKeyID "$APPLE_API_KEY_ID" -authenticationKeyIssuerID "$APPLE_API_ISSUER")

# App Store Connect refuses a build number it has already seen.
LATEST=$(asc builds info --app "$APP_ID" --latest --platform IOS --output json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.data?.attributes?.version??0)})')
if [ "$B" -le "$LATEST" ]; then
  echo "Build $B is not above the latest uploaded build $LATEST." >&2; exit 1
fi

OUT=build/release/$V-$B
rm -rf "$OUT"; mkdir -p "$OUT"
node Tools/generate-device-stream.mjs
xcodegen generate

echo "Archiving $V ($B)..."
xcodebuild -project SpecWithCode.xcodeproj -scheme SpecWithCode -configuration Release \
  -destination generic/platform=iOS -archivePath "$OUT/SpecWithCode.xcarchive" \
  -derivedDataPath build/DerivedData-archive \
  MARKETING_VERSION="$V" CURRENT_PROJECT_VERSION="$B" \
  -allowProvisioningUpdates "${AUTH[@]}" archive > "$OUT/archive.log" 2>&1 \
  || { tail -40 "$OUT/archive.log" >&2; exit 1; }

echo "Exporting..."
asc xcode export --archive-path "$OUT/SpecWithCode.xcarchive" --ipa-path "$OUT/SpecWithCode.ipa" \
  --export-options Config/ExportOptions.plist --xcodebuild-flag=-allowProvisioningUpdates \
  $(printf -- '--xcodebuild-flag=%s ' "${AUTH[@]}") --output json > "$OUT/export.json"

echo "Uploading..."
asc builds upload --app "$APP_ID" --ipa "$OUT/SpecWithCode.ipa" | tee "$OUT/upload.log"
asc builds wait --app "$APP_ID" --build-number "$B" --platform IOS | tee "$OUT/wait.log"
BUILD_ID=$(asc builds info --app "$APP_ID" --build-number "$B" --platform IOS --output json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.id))')
asc builds add-groups --build-id "$BUILD_ID" --group "$INTERNAL_GROUP" | tee "$OUT/groups.log"
if [ -n "$NOTES" ]; then
  asc builds test-notes create --build-id "$BUILD_ID" --locale en-US --whats-new "$NOTES" | tee "$OUT/notes.log"
fi
echo "Uploaded $V ($B) as $BUILD_ID; it is in the Internal TestFlight group."
