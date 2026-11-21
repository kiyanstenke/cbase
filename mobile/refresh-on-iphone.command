#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_PATH="$SCRIPT_DIR/CbaseMobile.xcodeproj"
XCODE_APP="${CBASE_XCODE_APP:-/Applications/Xcode.app}"
DEVICE_UDID="${CBASE_DEVICE_UDID:?set CBASE_DEVICE_UDID to the UDID of your iPhone}"
DERIVED_DATA="${CBASE_DERIVED_DATA:-$HOME/Library/Developer/Xcode/DerivedData/CbaseMobile-Device}"
APP_PATH="$DERIVED_DATA/Build/Products/Debug-iphoneos/cbase.app"

if [ ! -d "$XCODE_APP" ]; then
  echo "Xcode not found: $XCODE_APP" >&2
  exit 1
fi

# The signing team stays out of the project file (it names the Apple account): CBASE_DEVELOPMENT_TEAM, if set, is passed to xcodebuild.
TEAM_SETTING=${CBASE_DEVELOPMENT_TEAM:+DEVELOPMENT_TEAM=$CBASE_DEVELOPMENT_TEAM}
export DEVELOPER_DIR="$XCODE_APP/Contents/Developer"

echo "Signing cbase for the connected iPhone …"
xcodebuild -quiet \
  -project "$PROJECT_PATH" \
  -scheme CbaseMobile \
  -destination "platform=iOS,id=$DEVICE_UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  ${TEAM_SETTING} -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  build

echo "Installing cbase …"
xcrun devicectl device install app \
  --device "$DEVICE_UDID" \
  "$APP_PATH"

echo "Starting cbase …"
xcrun devicectl device process launch \
  --device "$DEVICE_UDID" \
  --terminate-existing \
  dev.cbase.mobile

echo "Done: cbase is updated and runs on the iPhone."
