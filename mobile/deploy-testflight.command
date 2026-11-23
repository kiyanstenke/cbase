#!/bin/sh
# Archives cbase and uploads the build straight to App Store Connect/TestFlight.
# Needs: a paid team in Xcode, an app record in App Store Connect with its agreements
# accepted.
#
# The build number is ours, not App Store Connect's (VERSIONING.md): CBASE_BUILD_NUMBER (and CBASE_VERSION) from `./deploy mobile --testflight`, else
# `node tools/version.mjs ios-build` (100 + commits on HEAD; refuses in a shallow clone). It goes to xcodebuild as
# CURRENT_PROJECT_VERSION and the export does not renumber it (manageAppVersionAndBuildNumber false). Only `./deploy` checks the
# store gate (clean tree exactly at v<version>) — run this script directly only from such a tree.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PROJECT_PATH="$SCRIPT_DIR/CbaseMobile.xcodeproj"
XCODE_APP="${CBASE_XCODE_APP:-/Applications/Xcode.app}"
VERSION="${CBASE_VERSION:-$(node "$REPO_DIR/tools/version.mjs")}"
BUILD_NUMBER="${CBASE_BUILD_NUMBER:-$(node "$REPO_DIR/tools/version.mjs" ios-build)}"
case "$BUILD_NUMBER" in
  ''|*[!0-9]*) echo "No usable build number: '$BUILD_NUMBER'" >&2; exit 1 ;;
esac
ARCHIVE_PATH="${CBASE_ARCHIVE_PATH:-$HOME/Library/Developer/Xcode/Archives/cbase-$VERSION-$BUILD_NUMBER.xcarchive}"
EXPORT_DIR=$(mktemp -d /tmp/cbase-testflight.XXXXXX)
trap 'rm -rf "$EXPORT_DIR"' EXIT INT TERM

if [ ! -d "$XCODE_APP" ]; then
  echo "Xcode not found: $XCODE_APP" >&2
  exit 1
fi
# The signing team stays out of the project file (it names the Apple account): CBASE_DEVELOPMENT_TEAM, if set, is passed to xcodebuild.
TEAM_SETTING=${CBASE_DEVELOPMENT_TEAM:+DEVELOPMENT_TEAM=$CBASE_DEVELOPMENT_TEAM}
export DEVELOPER_DIR="$XCODE_APP/Contents/Developer"

echo "Archiving cbase $VERSION ($BUILD_NUMBER) for App Store Connect …"
xcodebuild -quiet \
  -project "$PROJECT_PATH" \
  -scheme CbaseMobile \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  ${TEAM_SETTING} -allowProvisioningUpdates \
  archive

cat > "$EXPORT_DIR/ExportOptions.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST

echo "Uploading the archive to TestFlight …"
xcodebuild -quiet \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist "$EXPORT_DIR/ExportOptions.plist" \
  -exportPath "$EXPORT_DIR/export" \
  ${TEAM_SETTING} -allowProvisioningUpdates

echo "Done. Archive: $ARCHIVE_PATH"
echo "The build appears in App Store Connect → TestFlight after Apple has processed it."
