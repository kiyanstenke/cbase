#!/bin/sh
# Packs cbase as an IPA — for SideStore & co.
#
# Why at all: `refresh-on-iphone.command` pushes the finished .app bundle straight onto the device via Xcode, which produces no
# IPA. An IPA is just a ZIP with a `Payload/` folder at the root; the signature inside does not matter, because SideStore
# RE-signs it with the user's account on install.
#
# It is built for the DEVICE (arm64). A simulator build (`Debug-iphonesimulator`) does not run on the phone — the most common
# mix-up, hence the architecture is checked at the end.
#
# And as RELEASE: a debug build puts all the code into `cbase.debug.dylib` (plus `__preview.dylib`) next to a 92 kB start binary.
# When re-signing, the sideloader would have to take these dylibs along — an unnecessary risk. Release gives a single binary and a
# much smaller bundle (measured 19 MB instead of 28.7 MB). Switchable with CBASE_IPA_CONFIG=Debug.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_PATH="$SCRIPT_DIR/CbaseMobile.xcodeproj"
XCODE_APP="${CBASE_XCODE_APP:-/Applications/Xcode.app}"
DEVICE_UDID="${CBASE_DEVICE_UDID:?set CBASE_DEVICE_UDID to the UDID of your iPhone}"
DERIVED_DATA="${CBASE_DERIVED_DATA:-$HOME/Library/Developer/Xcode/DerivedData/CbaseMobile-Device}"
CONFIG="${CBASE_IPA_CONFIG:-Release}"
APP_PATH="$DERIVED_DATA/Build/Products/$CONFIG-iphoneos/cbase.app"
IPA_OUT="${CBASE_IPA_OUT:-$HOME/Desktop/cbase.ipa}"
STAGE=$(mktemp -d /tmp/cbase-ipa.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT INT TERM

if [ ! -d "$XCODE_APP" ]; then
  echo "Xcode was not found: $XCODE_APP" >&2
  exit 1
fi
# The signing team stays out of the project file (it names the Apple account): CBASE_DEVELOPMENT_TEAM, if set, is passed to xcodebuild.
TEAM_SETTING=${CBASE_DEVELOPMENT_TEAM:+DEVELOPMENT_TEAM=$CBASE_DEVELOPMENT_TEAM}
export DEVELOPER_DIR="$XCODE_APP/Contents/Developer"

# If the iPhone is reachable (cable OR Wi-Fi), sign for it (so Xcode can also issue a profile anew); otherwise build for any iOS
# device — that suffices as long as the device is already in the profile.
#
# The same rule as the deploy tool's iphone.mjs (measurements there): do NOT read the table of `devicectl list devices` — it
# writes `available (paired)`, the word "connected" does not appear in it, so every iPhone used to count as "not plugged in".
# The tunnel of a paired device sleeps anyway (cable as well as Wi-Fi); `device info details` wakes it and then writes
# `"tunnelState" : "connected"` into the JSON (format measured with devicectl 518.33). `unavailable` (out of range, locked)
# does not count.
DEVICE_JSON="$STAGE/device.json"
TRANSPORT=""
iphone_reachable() {
  xcrun devicectl device info details --device "$DEVICE_UDID" --json-output "$DEVICE_JSON" >/dev/null 2>&1 || true
  [ -f "$DEVICE_JSON" ] || return 1
  grep -q '"tunnelState" *: *"connected"' "$DEVICE_JSON" || return 1
  case "$(sed -n 's/.*"transportType" *: *"\([^"]*\)".*/\1/p' "$DEVICE_JSON" | head -1)" in
    localNetwork) TRANSPORT=" (Wi-Fi)" ;;
    wired) TRANSPORT=" (cable)" ;;
  esac
  return 0
}
if iphone_reachable; then
  DESTINATION="platform=iOS,id=$DEVICE_UDID"
  echo "iPhone detected$TRANSPORT — cbase is signed for it …"
else
  DESTINATION="generic/platform=iOS"
  echo "No iPhone reachable (cable or Wi-Fi) — building for any iOS device."
  echo "(If signing fails, unlock/plug in the iPhone and start again.)"
fi

xcodebuild -quiet \
  -project "$PROJECT_PATH" \
  -scheme CbaseMobile \
  -configuration "$CONFIG" \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED_DATA" \
  ${TEAM_SETTING} -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  build

[ -d "$APP_PATH" ] || { echo "Device build is missing: $APP_PATH" >&2; exit 1; }

echo "Packing the IPA …"
mkdir -p "$STAGE/Payload"
cp -R "$APP_PATH" "$STAGE/Payload/"
rm -f "$IPA_OUT"
# -y: store symlinks as symlinks (the frameworks in the bundle consist of them).
( cd "$STAGE" && zip -qry "$IPA_OUT" Payload )

# Counter-check: does Payload/ lie at the root and is the binary really for the device?
unzip -l "$IPA_OUT" | grep -q "Payload/cbase.app/cbase" || {
  echo "The IPA does not contain Payload/cbase.app/cbase — archive unusable." >&2
  exit 1
}
if [ "$CONFIG" = "Release" ] && ls "$APP_PATH"/*.debug.dylib >/dev/null 2>&1; then
  echo "WARNING: Release bundle contains a debug dylib — the code would then lie outside the binary." >&2
fi
ARCHS=$(lipo -archs "$APP_PATH/cbase" 2>/dev/null || echo "?")
case "$ARCHS" in
  *arm64*) : ;;
  *) echo "WARNING: binary is $ARCHS — a simulator build does not run on the iPhone." >&2 ;;
esac

SIZE=$(du -h "$IPA_OUT" | cut -f1)
BUILT=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$APP_PATH/cbase")
cat <<EOF

Done: $IPA_OUT  ($SIZE, $CONFIG, $ARCHS, built $BUILT)

How to get it onto the iPhone:
  1. Send it by AirDrop → "Save to Files" → On My iPhone.
     (iCloud Drive works too, but then really download the file —
      a merely offloaded file cannot be opened by the file picker.)
  2. DELETE the cbase installed via Xcode from the home screen. iOS does not allow an
     installation with another signing profile over it. That also removes the stored
     server address — enter it again at the first start.
  3. SideStore → "+" → choose cbase.ipa from "Files" → install.

After that: "Refresh" in SideStore renews only the certificate, NOT the code.
After every code change run this script again and install the new IPA.
EOF
