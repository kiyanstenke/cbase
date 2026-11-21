#!/bin/sh
# Archives cbase and uploads the build straight to App Store Connect/TestFlight.
# Needs: a paid team in Xcode, an app record in App Store Connect with its agreements
# accepted. App Store Connect may manage the build numbers itself.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_PATH="$SCRIPT_DIR/CbaseMobile.xcodeproj"
XCODE_APP="${CBASE_XCODE_APP:-/Applications/Xcode.app}"
ARCHIVE_PATH="${CBASE_ARCHIVE_PATH:-$HOME/Library/Developer/Xcode/Archives/cbase-$(date +%Y%m%d-%H%M).xcarchive}"
EXPORT_DIR=$(mktemp -d /tmp/cbase-testflight.XXXXXX)
trap 'rm -rf "$EXPORT_DIR"' EXIT INT TERM

if [ ! -d "$XCODE_APP" ]; then
  echo "Xcode not found: $XCODE_APP" >&2
  exit 1
fi
# The signing team stays out of the project file (it names the Apple account): CBASE_DEVELOPMENT_TEAM, if set, is passed to xcodebuild.
TEAM_SETTING=${CBASE_DEVELOPMENT_TEAM:+DEVELOPMENT_TEAM=$CBASE_DEVELOPMENT_TEAM}
export DEVELOPER_DIR="$XCODE_APP/Contents/Developer"

echo "Archiving cbase for App Store Connect …"
xcodebuild -quiet \
  -project "$PROJECT_PATH" \
  -scheme CbaseMobile \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  ${TEAM_SETTING} -allowProvisioningUpdates \
  archive

cat > "$EXPORT_DIR/ExportOptions.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><true/>
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
